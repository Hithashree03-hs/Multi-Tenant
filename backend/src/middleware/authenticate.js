const jwt = require("jsonwebtoken");

const ALLOWED_ROLES = new Set(["ADMIN", "FACULTY", "STUDENT"]);
const JWT_SECRET_MIN_BYTES = 32;

function createAuthMiddleware(jwtSecret = process.env.JWT_SECRET, options = {}) {
  return async function authenticate(req, res, next) {
    if (typeof jwtSecret !== "string" || Buffer.byteLength(jwtSecret, "utf8") < JWT_SECRET_MIN_BYTES) {
      return res.status(503).json({ success: false, message: "Authentication is not configured" });
    }

    const authorization = req.get("authorization") || "";
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (!match) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    let payload;
    try {
      payload = jwt.verify(match[1], jwtSecret, { algorithms: ["HS256"] });
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.sub !== "string" ||
        !payload.sub ||
        !ALLOWED_ROLES.has(payload.role) ||
        typeof payload.organizationId !== "string" ||
        !payload.organizationId
      ) {
        return res.status(401).json({ success: false, message: "Invalid or expired token" });
      }
    } catch (error) {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }

    let principal = {
      id: payload.sub,
      role: payload.role,
      organizationId: payload.organizationId,
    };

    if (typeof options.resolvePrincipal === "function") {
      try {
        const currentUser = await options.resolvePrincipal(payload.sub, payload.organizationId);
        if (
          !currentUser ||
          currentUser.id !== payload.sub ||
          currentUser.organizationId !== payload.organizationId ||
          !ALLOWED_ROLES.has(currentUser.role)
        ) {
          return res.status(401).json({ success: false, message: "Invalid or expired token" });
        }

        // Use current database role and tenant membership so a stale token
        // cannot retain permissions after the account changes.
        principal = {
          id: currentUser.id,
          role: currentUser.role,
          organizationId: currentUser.organizationId,
        };
      } catch (error) {
        return res.status(500).json({ success: false, message: "Failed to authenticate request" });
      }
    }

    // Authorization data never comes from request body or query parameters.
    req.user = principal;
    return next();
  };
}

module.exports = createAuthMiddleware;
