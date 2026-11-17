const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { rateLimit } = require("express-rate-limit");
const createAuthMiddleware = require("../middleware/authenticate");
const { hashPassword } = require("../security/passwords");

const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;
const JWT_SECRET_MIN_BYTES = 32;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ALLOWED_ROLES = new Set(["ADMIN", "FACULTY", "STUDENT"]);
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX = 20;

function positiveIntegerSetting(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(body, allowedKeys) {
  return Object.keys(body).every((key) => allowedKeys.has(key));
}

function publicUser(user) {
  // Build responses from an allowlist so neither plaintext nor hashed passwords
  // can accidentally be sent back if the database result changes in the future.
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    createdAt: user.createdAt,
  };
}

function createAuthRouter(prismaClient, options = {}) {
  const router = express.Router();
  const jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET;
  const registrationOrganizationId = options.registrationOrganizationId ?? process.env.DEFAULT_ORGANIZATION_ID;
  const authRateLimit = rateLimit({
    windowMs: positiveIntegerSetting(options.authRateLimitWindowMs ?? process.env.AUTH_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
    limit: positiveIntegerSetting(options.authRateLimitMax ?? process.env.AUTH_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler(_req, res) {
      return res.status(429).json({ success: false, message: "Too many authentication requests. Try again later." });
    },
  });
  const authenticate = createAuthMiddleware(jwtSecret, {
    resolvePrincipal: options.resolvePrincipal,
  });

  router.get("/me", authenticate, async (req, res) => {
    try {
      // Both identifiers come from the verified JWT. A caller cannot select a
      // different user's profile or another organization's data with a query.
      const user = await prismaClient.user.findFirst({
        where: {
          id: req.user.id,
          organizationId: req.user.organizationId,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          organizationId: true,
          createdAt: true,
        },
      });

      if (!user) {
        return res.status(404).json({ success: false, message: "User profile not found" });
      }

      return res.json({ success: true, data: { user: publicUser(user) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch user profile" });
    }
  });

  router.post("/register", authRateLimit, async (req, res) => {
    const body = req.body;
    const allowedKeys = new Set(["name", "email", "password"]);

    if (!isPlainObject(body) || !hasOnlyKeys(body, allowedKeys)) {
      return res.status(400).json({
        success: false,
        message: "Request must contain only name, email, and password",
      });
    }

    if (typeof body.name !== "string" || typeof body.email !== "string" || typeof body.password !== "string") {
      return res.status(400).json({
        success: false,
        message: "Name, email, and password are required",
      });
    }

    const name = body.name.trim();
    const email = body.email.trim().toLowerCase();
    const password = body.password;

    if (!name || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Name must be between 1 and ${MAX_NAME_LENGTH} characters`,
      });
    }

    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ success: false, message: "Email address is invalid" });
    }

    if (password.length < MIN_PASSWORD_LENGTH || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
      return res.status(400).json({
        success: false,
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters and no more than ${MAX_PASSWORD_BYTES} UTF-8 bytes`,
      });
    }

    // Membership is assigned from server configuration. The request cannot
    // select an organization or elevate its role.
    if (typeof registrationOrganizationId !== "string" || !registrationOrganizationId.trim()) {
      return res.status(503).json({ success: false, message: "Registration is not configured" });
    }

    try {
      const organization = await prismaClient.organization.findUnique({
        where: { id: registrationOrganizationId },
        select: { id: true },
      });

      if (!organization) {
        return res.status(503).json({ success: false, message: "Registration is not available" });
      }

      const passwordHash = await hashPassword(password);
      const user = await prismaClient.user.create({
        data: {
          name,
          email,
          password: passwordHash,
          role: "STUDENT",
          organizationId: organization.id,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          organizationId: true,
          createdAt: true,
        },
      });

      return res.status(201).json({ success: true, data: { user: publicUser(user) } });
    } catch (error) {
      if (error && error.code === "P2002") {
        return res.status(409).json({ success: false, message: "An account with this email already exists" });
      }
      return res.status(500).json({ success: false, message: "Failed to register account" });
    }
  });

  router.post("/login", authRateLimit, async (req, res) => {
    const body = req.body;
    const allowedKeys = new Set(["email", "password"]);

    if (!isPlainObject(body) || !hasOnlyKeys(body, allowedKeys)) {
      return res.status(400).json({
        success: false,
        message: "Request must contain only email and password",
      });
    }

    if (typeof body.email !== "string" || typeof body.password !== "string") {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const email = body.email.trim().toLowerCase();
    if (
      email.length > MAX_EMAIL_LENGTH ||
      !EMAIL_PATTERN.test(email) ||
      !body.password ||
      Buffer.byteLength(body.password, "utf8") > MAX_PASSWORD_BYTES
    ) {
      return res.status(400).json({ success: false, message: "Email or password is invalid" });
    }

    try {
      const user = await prismaClient.user.findUnique({ where: { email } });
      const passwordMatches = user && typeof user.password === "string"
        ? await bcrypt.compare(body.password, user.password)
        : false;

      if (!passwordMatches) {
        return res.status(401).json({ success: false, message: "Invalid email or password" });
      }

      if (typeof jwtSecret !== "string" || Buffer.byteLength(jwtSecret, "utf8") < JWT_SECRET_MIN_BYTES) {
        return res.status(503).json({ success: false, message: "Authentication is not configured" });
      }

      if (!ALLOWED_ROLES.has(user.role) || typeof user.organizationId !== "string") {
        return res.status(500).json({ success: false, message: "Failed to authenticate account" });
      }

      const token = jwt.sign(
        { role: user.role, organizationId: user.organizationId },
        jwtSecret,
        { subject: user.id, expiresIn: "1h", algorithm: "HS256" },
      );

      return res.json({ success: true, data: { token, user: publicUser(user) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to authenticate account" });
    }
  });

  return router;
}

module.exports = createAuthRouter;
