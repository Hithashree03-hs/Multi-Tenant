const express = require("express");
const bcrypt = require("bcrypt");
const createAuthMiddleware = require("../middleware/authenticate");
const requireRole = require("../middleware/authorizeRoles");

const BCRYPT_ROUNDS = 12;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_BYTES = 72;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MANAGED_ROLES = new Set(["FACULTY", "STUDENT"]);
const SAFE_USER_FIELDS = {
  id: true,
  name: true,
  email: true,
  role: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePagination(query) {
  const pageText = query.page === undefined ? "1" : query.page;
  const limitText = query.limit === undefined ? "20" : query.limit;
  if (
    typeof pageText !== "string" || !/^\d+$/.test(pageText) ||
    typeof limitText !== "string" || !/^\d+$/.test(limitText)
  ) return null;

  const page = Number(pageText);
  const limit = Number(limitText);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) return null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  return { page, limit };
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function normalizeName(value) {
  return value.trim();
}

function validateUserFields(body, { partial = false, allowedKeys } = {}) {
  if (!isObject(body)) return "Request body must be a JSON object";
  if (!Object.keys(body).every((key) => allowedKeys.has(key))) {
    return "Request contains unsupported fields";
  }
  if (partial && Object.keys(body).length === 0) return "At least one field is required";

  for (const key of ["name", "email", "password", "role"]) {
    if (body[key] !== undefined && typeof body[key] !== "string") return `${key} must be a string`;
  }
  if (!partial && (typeof body.name !== "string" || typeof body.email !== "string" || typeof body.password !== "string")) {
    return "Name, email, and password are required";
  }

  if (body.name !== undefined) {
    const name = normalizeName(body.name);
    if (!name || name.length > MAX_NAME_LENGTH) return `Name must be between 1 and ${MAX_NAME_LENGTH} characters`;
  }
  if (body.email !== undefined) {
    const email = body.email.trim().toLowerCase();
    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return "Email address is invalid";
  }
  if (body.password !== undefined) {
    if (body.password.length < 8 || Buffer.byteLength(body.password, "utf8") > MAX_PASSWORD_BYTES) {
      return "Password must be at least 8 characters and no more than 72 UTF-8 bytes";
    }
  }
  if (body.role !== undefined && !MANAGED_ROLES.has(body.role)) {
    if (body.role === "ADMIN") return "Tenant administrators cannot assign the ADMIN role";
    return "Role must be FACULTY or STUDENT";
  }
  return null;
}

function createUserRouter(prismaClient, options = {}) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(options.jwtSecret, {
    resolvePrincipal: options.resolvePrincipal,
  });
  const requireManager = requireRole("ADMIN", "FACULTY");
  const requireAdmin = requireRole("ADMIN");

  router.get("/", authenticate, requireManager, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    const { page, limit } = pagination;
    // Faculty workflows are intentionally limited to student directory records.
    const where = {
      organizationId: req.user.organizationId,
      ...(req.user.role === "FACULTY" ? { role: "STUDENT" } : {}),
    };

    try {
      const [users, total] = await Promise.all([
        prismaClient.user.findMany({
          where,
          select: SAFE_USER_FIELDS,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prismaClient.user.count({ where }),
      ]);
      return res.json({
        success: true,
        data: users.map(safeUser),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch users" });
    }
  });

  router.get("/:id", authenticate, requireManager, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "User ID is invalid" });
    const where = {
      id: req.params.id,
      organizationId: req.user.organizationId,
      ...(req.user.role === "FACULTY" ? { role: "STUDENT" } : {}),
    };
    try {
      const user = await prismaClient.user.findFirst({ where, select: SAFE_USER_FIELDS });
      if (!user) return res.status(404).json({ success: false, message: "User not found" });
      return res.json({ success: true, data: safeUser(user) });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch user" });
    }
  });

  router.post("/", authenticate, requireAdmin, async (req, res) => {
    const validationError = validateUserFields(req.body, {
      allowedKeys: new Set(["name", "email", "password", "role"]),
    });
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    const role = req.body.role || "STUDENT";

    try {
      const user = await prismaClient.user.create({
        data: {
          name: normalizeName(req.body.name),
          email: req.body.email.trim().toLowerCase(),
          password: await bcrypt.hash(req.body.password, BCRYPT_ROUNDS),
          role,
          organizationId: req.user.organizationId,
        },
        select: SAFE_USER_FIELDS,
      });
      return res.status(201).json({ success: true, data: safeUser(user) });
    } catch (error) {
      if (error && error.code === "P2002") {
        return res.status(409).json({ success: false, message: "An account with this email already exists" });
      }
      return res.status(500).json({ success: false, message: "Failed to create user" });
    }
  });

  router.patch("/:id", authenticate, requireAdmin, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "User ID is invalid" });
    const validationError = validateUserFields(req.body, {
      partial: true,
      allowedKeys: new Set(["name", "email", "password", "role"]),
    });
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    try {
      const current = await prismaClient.user.findFirst({
        where: { id: req.params.id, organizationId: req.user.organizationId },
        select: { id: true, role: true },
      });
      if (!current) return res.status(404).json({ success: false, message: "User not found" });
      if (current.role === "ADMIN") {
        return res.status(403).json({ success: false, message: "Administrator accounts cannot be changed here" });
      }
      if (current.role === "FACULTY" && req.body.role === "STUDENT") {
        const assignedCourses = await prismaClient.course.count({
          where: { organizationId: req.user.organizationId, facultyId: current.id },
        });
        if (assignedCourses > 0) {
          return res.status(409).json({ success: false, message: "Reassign this faculty member's courses before changing their role" });
        }
      }

      const data = {};
      if (req.body.name !== undefined) data.name = normalizeName(req.body.name);
      if (req.body.email !== undefined) data.email = req.body.email.trim().toLowerCase();
      if (req.body.password !== undefined) data.password = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
      if (req.body.role !== undefined) data.role = req.body.role;

      const result = await prismaClient.user.updateMany({
        where: {
          id: current.id,
          organizationId: req.user.organizationId,
          role: { in: ["FACULTY", "STUDENT"] },
        },
        data,
      });
      if (result.count === 0) return res.status(404).json({ success: false, message: "User not found" });

      const user = await prismaClient.user.findFirst({
        where: { id: current.id, organizationId: req.user.organizationId },
        select: SAFE_USER_FIELDS,
      });
      return res.json({ success: true, data: safeUser(user) });
    } catch (error) {
      if (error && error.code === "P2002") {
        return res.status(409).json({ success: false, message: "An account with this email already exists" });
      }
      return res.status(500).json({ success: false, message: "Failed to update user" });
    }
  });

  return router;
}

module.exports = createUserRouter;
