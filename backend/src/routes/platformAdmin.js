
const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { rateLimit } = require("express-rate-limit");

const MIN_SECRET_BYTES = 32;
const TOKEN_LIFETIME = "1h";

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createPlatformAdminRouter(prismaClient, options = {}) {
  const router = express.Router();
  const adminEmail = (options.platformAdminEmail ?? process.env.PLATFORM_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const adminPassword = options.platformAdminPassword ?? process.env.PLATFORM_ADMIN_PASSWORD;
  const tokenSecret = options.platformAdminJwtSecret ?? process.env.PLATFORM_ADMIN_JWT_SECRET;

  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      success: false,
      message: "Too many platform-admin login attempts. Try again later.",
    },
  });

  function authenticatePlatformAdmin(req, res, next) {
    if (
      typeof tokenSecret !== "string" ||
      Buffer.byteLength(tokenSecret, "utf8") < MIN_SECRET_BYTES
    ) {
      return res.status(503).json({
        success: false,
        message: "Platform-admin authentication is not configured.",
      });
    }

    const authorization = req.get("authorization") || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        success: false,
        message: "Platform-admin login is required.",
      });
    }

    try {
      const payload = jwt.verify(match[1], tokenSecret, {
        algorithms: ["HS256"],
      });

      if (payload.scope !== "platform-admin") {
        throw new Error("Invalid platform-admin scope");
      }

      req.platformAdmin = true;
      return next();
    } catch {
      return res.status(401).json({
        success: false,
        message: "Platform-admin session is invalid or expired. Please log in again.",
      });
    }
  }

  router.post("/login", loginLimit, (req, res) => {
    const { email, password } = req.body || {};

    if (
      typeof adminEmail !== "string" ||
      !adminEmail ||
      typeof adminPassword !== "string" ||
      !adminPassword ||
      typeof tokenSecret !== "string" ||
      Buffer.byteLength(tokenSecret, "utf8") < MIN_SECRET_BYTES
    ) {
      return res.status(503).json({
        success: false,
        message: "Platform-admin authentication is not configured.",
      });
    }

    const emailMatches =
      typeof email === "string" &&
      safeEqual(email.trim().toLowerCase(), adminEmail);
    const passwordMatches =
      typeof password === "string" &&
      safeEqual(password, adminPassword);

    if (!emailMatches || !passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid platform-admin email or password.",
      });
    }

    const token = jwt.sign(
      { scope: "platform-admin" },
      tokenSecret,
      { expiresIn: TOKEN_LIFETIME, algorithm: "HS256" },
    );

    return res.json({
      success: true,
      data: { token, expiresIn: TOKEN_LIFETIME },
    });
  });

  router.get("/organizations", authenticatePlatformAdmin, async (_req, res) => {
    try {
      const organizations = await prismaClient.organization.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return res.json({ success: true, data: organizations });
    } catch {
      return res.status(500).json({
        success: false,
        message: "Failed to load organizations.",
      });
    }
  });

  router.post("/organizations", authenticatePlatformAdmin, async (req, res) => {
    const { name, slug } = req.body || {};

    if (
      typeof name !== "string" ||
      typeof slug !== "string" ||
      !name.trim() ||
      name.trim().length > 120 ||
      slug.length > 63 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid organization name and lowercase slug.",
      });
    }

    try {
      const organization = await prismaClient.organization.create({
        data: { name: name.trim(), slug },
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return res.status(201).json({
        success: true,
        message: "Organization created successfully.",
        data: organization,
      });
    } catch (error) {
      if (error?.code === "P2002") {
        return res.status(409).json({
          success: false,
          message: "An organization with that slug already exists.",
        });
      }

      return res.status(500).json({
        success: false,
        message: "Failed to create organization.",
      });
    }
  });

  return router;
}

module.exports = createPlatformAdminRouter;
