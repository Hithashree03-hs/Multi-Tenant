const express = require("express");
const createAuthMiddleware = require("../middleware/authenticate");
const requireRole = require("../middleware/authorizeRoles");

const MAX_NAME_LENGTH = 120;
const MAX_CODE_LENGTH = 20;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const SAFE_DEPARTMENT_FIELDS = {
  id: true,
  name: true,
  code: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateBody(body, { partial = false } = {}) {
  if (!isObject(body)) return "Request body must be a JSON object";
  if (!Object.keys(body).every((key) => key === "name" || key === "code")) {
    return "Only name and code are allowed; organization is assigned from your account";
  }
  if (partial && Object.keys(body).length === 0) return "At least one field is required";
  if (!partial && (typeof body.name !== "string" || typeof body.code !== "string")) {
    return "Name and code must be strings";
  }
  if (body.name !== undefined && typeof body.name !== "string") return "Name must be a string";
  if (body.code !== undefined && typeof body.code !== "string") return "Code must be a string";

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return "Name must not be empty";
    if (name.length > MAX_NAME_LENGTH) return `Name must be ${MAX_NAME_LENGTH} characters or fewer`;
  }
  if (body.code !== undefined) {
    const code = body.code.trim().toUpperCase();
    if (!code || code.length > MAX_CODE_LENGTH || !CODE_PATTERN.test(code)) {
      return `Code must be at most ${MAX_CODE_LENGTH} characters and contain uppercase letters, numbers, and single hyphens only`;
    }
  }
  return null;
}

function normalizedBody(body) {
  const data = {};
  if (body.name !== undefined) data.name = body.name.trim();
  if (body.code !== undefined) data.code = body.code.trim().toUpperCase();
  return data;
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

function createDepartmentRouter(prismaClient, options = {}) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(options.jwtSecret, {
    resolvePrincipal: options.resolvePrincipal,
  });
  const requireAdmin = requireRole("ADMIN");

  router.get("/", authenticate, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    const { page, limit } = pagination;
    const where = { organizationId: req.user.organizationId };

    try {
      const [departments, total] = await Promise.all([
        prismaClient.department.findMany({
          where,
          select: SAFE_DEPARTMENT_FIELDS,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prismaClient.department.count({ where }),
      ]);
      return res.json({
        success: true,
        data: departments,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch departments" });
    }
  });

  router.get("/:id", authenticate, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Department ID is invalid" });
    try {
      const department = await prismaClient.department.findFirst({
        where: { id: req.params.id, organizationId: req.user.organizationId },
        select: SAFE_DEPARTMENT_FIELDS,
      });
      if (!department) return res.status(404).json({ success: false, message: "Department not found" });
      return res.json({ success: true, data: department });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch department" });
    }
  });

  router.post("/", authenticate, requireAdmin, async (req, res) => {
    const validationError = validateBody(req.body);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    try {
      const department = await prismaClient.department.create({
        data: { ...normalizedBody(req.body), organizationId: req.user.organizationId },
        select: SAFE_DEPARTMENT_FIELDS,
      });
      return res.status(201).json({ success: true, data: department });
    } catch (error) {
      if (error && error.code === "P2002") {
        return res.status(409).json({ success: false, message: "A department with this code already exists in your organization" });
      }
      if (error && error.code === "P2003") {
        return res.status(409).json({ success: false, message: "The organization for this department no longer exists" });
      }
      return res.status(500).json({ success: false, message: "Failed to create department" });
    }
  });

  router.patch("/:id", authenticate, requireAdmin, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Department ID is invalid" });
    const validationError = validateBody(req.body, { partial: true });
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    try {
      const result = await prismaClient.department.updateMany({
        where: { id: req.params.id, organizationId: req.user.organizationId },
        data: normalizedBody(req.body),
      });
      if (result.count === 0) return res.status(404).json({ success: false, message: "Department not found" });

      const department = await prismaClient.department.findFirst({
        where: { id: req.params.id, organizationId: req.user.organizationId },
        select: SAFE_DEPARTMENT_FIELDS,
      });
      return res.json({ success: true, data: department });
    } catch (error) {
      if (error && error.code === "P2002") {
        return res.status(409).json({ success: false, message: "A department with this code already exists in your organization" });
      }
      return res.status(500).json({ success: false, message: "Failed to update department" });
    }
  });

  router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Department ID is invalid" });
    try {
      const result = await prismaClient.department.deleteMany({
        where: { id: req.params.id, organizationId: req.user.organizationId },
      });
      if (result.count === 0) return res.status(404).json({ success: false, message: "Department not found" });
      return res.json({ success: true, message: "Department deleted" });
    } catch (error) {
      if (error && error.code === "P2003") {
        return res.status(409).json({ success: false, message: "Department still has related records" });
      }
      return res.status(500).json({ success: false, message: "Failed to delete department" });
    }
  });

  return router;
}

module.exports = createDepartmentRouter;
