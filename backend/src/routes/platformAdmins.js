
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { rateLimit } = require("express-rate-limit");

function createPlatformAdminsRouter(prisma, options = {}) {
  const router = express.Router();
  const jwtSecret = options.platformAdminJwtSecret ||
    process.env.PLATFORM_ADMIN_JWT_SECRET;

  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });

  function requirePlatformAdmin(req, res, next) {
    if (
      typeof jwtSecret !== "string" ||
      Buffer.byteLength(jwtSecret, "utf8") < 32
    ) {
      return res.status(503).json({
        success: false,
        message: "Platform-admin authentication is not configured.",
      });
    }

    const match = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        success: false,
        message: "Platform-admin login required.",
      });
    }

    try {
      const payload = jwt.verify(match[1], jwtSecret, {
        algorithms: ["HS256"],
      });

      if (payload.scope !== "platform-admin") {
        throw new Error("Invalid token scope");
      }

      req.platformAdminId = payload.sub;
      next();
    } catch {
      return res.status(401).json({
        success: false,
        message: "Platform-admin session is invalid or expired.",
      });
    }
  }

  router.post("/login", loginLimit, async (req, res) => {
    const email = typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
    const password = req.body?.password;

    if (!email || typeof password !== "string") {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    if (
      typeof jwtSecret !== "string" ||
      Buffer.byteLength(jwtSecret, "utf8") < 32
    ) {
      return res.status(503).json({
        success: false,
        message: "Platform-admin authentication is not configured.",
      });
    }

    try {
      const admin = await prisma.platformAdmin.findUnique({
        where: { email },
      });

      const matches = admin && admin.isActive
        ? await bcrypt.compare(password, admin.passwordHash)
        : false;

      if (!matches) {
        return res.status(401).json({
          success: false,
          message: "Invalid email or password.",
        });
      }

      const token = jwt.sign(
        { scope: "platform-admin" },
        jwtSecret,
        {
          subject: admin.id,
          expiresIn: "1h",
          algorithm: "HS256",
        },
      );

      return res.json({
        success: true,
        data: {
          token,
          admin: {
            id: admin.id,
            name: admin.name,
            email: admin.email,
          },
        },
      });
    } catch {
      return res.status(500).json({
        success: false,
        message: "Failed to authenticate platform admin.",
      });
    }
  });

  router.get("/admins", requirePlatformAdmin, async (_req, res) => {
    try {
      const admins = await prisma.platformAdmin.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          isActive: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return res.json({ success: true, data: admins });
    } catch {
      return res.status(500).json({
        success: false,
        message: "Failed to load platform admins.",
      });
    }
  });

  router.post("/admins", requirePlatformAdmin, async (req, res) => {
    const name = typeof req.body?.name === "string"
      ? req.body.name.trim()
      : "";
    const email = typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
    const password = req.body?.password;

    if (
      !name ||
      name.length > 120 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ||
      typeof password !== "string" ||
      password.length < 12 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid name, email, and password of 12–72 UTF-8 bytes.",
      });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const admin = await prisma.platformAdmin.create({
        data: { name, email, passwordHash },
        select: {
          id: true,
          name: true,
          email: true,
          isActive: true,
          createdAt: true,
        },
      });

      return res.status(201).json({
        success: true,
        data: admin,
      });
    } catch (error) {
      if (error?.code === "P2002") {
        return res.status(409).json({
          success: false,
          message: "A platform admin with this email already exists.",
        });
      }

      return res.status(500).json({
        success: false,
        message: "Failed to create platform admin.",
      });
    }
  });

  return router;
}

module.exports = createPlatformAdminsRouter;
