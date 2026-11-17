const { timingSafeEqual } = require("node:crypto");

const MIN_PLATFORM_SECRET_BYTES = 32;
const HEADER_NAME = "x-platform-admin-key";

function isConfigured(secret) {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= MIN_PLATFORM_SECRET_BYTES;
}

function matchesSecret(provided, expected) {
  if (typeof provided !== "string" || !isConfigured(expected)) return false;
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

function requirePlatformAdmin(secret = process.env.PLATFORM_ADMIN_SECRET) {
  return function platformAdminOnly(req, res, next) {
    if (!isConfigured(secret)) {
      return res.status(503).json({ success: false, message: "Platform administration is not configured" });
    }
    if (!matchesSecret(req.get(HEADER_NAME), secret)) {
      return res.status(403).json({ success: false, message: "Platform administrator access required" });
    }
    req.isPlatformAdmin = true;
    return next();
  };
}

function platformAdminOrTenantUser(secret = process.env.PLATFORM_ADMIN_SECRET, authenticate) {
  const platformOnly = requirePlatformAdmin(secret);
  return function authorizeOrganizationRead(req, res, next) {
    if (req.get(HEADER_NAME) !== undefined) {
      return platformOnly(req, res, next);
    }
    if (typeof authenticate !== "function") {
      return res.status(500).json({ success: false, message: "Authentication is not configured" });
    }
    return authenticate(req, res, next);
  };
}

module.exports = {
  isConfigured,
  matchesSecret,
  requirePlatformAdmin,
  platformAdminOrTenantUser,
};
