const express = require("express");
const createAuthMiddleware = require("../middleware/authenticate");
const requireRole = require("../middleware/authorizeRoles");
const {
  platformAdminOrTenantUser,
  requirePlatformAdmin,
} = require("../middleware/platformAdmin");

const MAX_NAME_LENGTH = 120;
const MAX_SLUG_LENGTH = 63;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_ORGANIZATION_FIELDS = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
  updatedAt: true,
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateFields(body, { partial = false } = {}) {
  if (!isObject(body)) return "Request body must be a JSON object";
  if (!Object.keys(body).every((key) => key === "name" || key === "slug")) {
    return "Only name and slug are allowed";
  }
  if (partial && Object.keys(body).length === 0) return "At least one field is required";
  if (!partial && (typeof body.name !== "string" || typeof body.slug !== "string")) {
    return "Name and slug must be strings";
  }
  if (body.name !== undefined && typeof body.name !== "string") return "Name must be a string";
  if (body.slug !== undefined && typeof body.slug !== "string") return "Slug must be a string";

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return "Name must not be empty";
    if (name.length > MAX_NAME_LENGTH) return `Name must be ${MAX_NAME_LENGTH} characters or fewer`;
  }
  if (body.slug !== undefined) {
    const slug = body.slug.trim();
    if (!slug || slug.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(slug)) {
      return `Slug must be at most ${MAX_SLUG_LENGTH} characters and contain lowercase letters, numbers, and single hyphens only`;
    }
  }
  return null;
}

function normalizedFields(body) {
  const data = {};
  if (body.name !== undefined) data.name = body.name.trim();
  if (body.slug !== undefined) data.slug = body.slug.trim();
  return data;
}

function createOrganizationRouter(prismaClient, options = {}) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(options.jwtSecret, {
    resolvePrincipal: options.resolvePrincipal,
  });
  const readAuthorization = platformAdminOrTenantUser(options.platformAdminSecret, authenticate);
  const platformAdmin = requirePlatformAdmin(options.platformAdminSecret);
  const requireTenantAdmin = requireRole("ADMIN");

  function requireOrganizationAdminOrPlatform(req, res, next) {
    if (req.isPlatformAdmin) return next();
    return requireTenantAdmin(req, res, next);
  }

  router.get("/", readAuthorization, async (req, res) => {
    try {
      if (req.isPlatformAdmin) {
        const organizations = await prismaClient.organization.findMany({
          select: SAFE_ORGANIZATION_FIELDS,
          orderBy: { name: "asc" },
        });
        return res.json({ success: true, data: organizations });
      }

      const organization = await prismaClient.organization.findUnique({
        where: { id: req.user.organizationId },
        select: SAFE_ORGANIZATION_FIELDS,
      });
      return res.json({ success: true, data: organization ? [organization] : [] });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch organizations" });
    }
  });

  router.get("/:id", readAuthorization, async (req, res) => {
    const { id } = req.params;
    if (!ID_PATTERN.test(id)) return res.status(400).json({ success: false, message: "Organization ID is invalid" });

    try {
      const organization = req.isPlatformAdmin
        ? await prismaClient.organization.findUnique({ where: { id }, select: SAFE_ORGANIZATION_FIELDS })
        : id === req.user.organizationId
          ? await prismaClient.organization.findUnique({
            where: { id: req.user.organizationId },
            select: SAFE_ORGANIZATION_FIELDS,
          })
          : null;

      if (!organization) return res.status(404).json({ success: false, message: "Organization not found" });
      return res.json({ success: true, data: organization });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch organization" });
    }
  });

  router.post("/", platformAdmin, async (req, res) => {
    const validationError = validateFields(req.body);
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    try {
      const organization = await prismaClient.organization.create({
        data: normalizedFields(req.body),
        select: SAFE_ORGANIZATION_FIELDS,
      });
      return res.status(201).json({ success: true, data: organization });
    } catch (error) {
      if (error && error.code === "P2002") {
        return res.status(409).json({ success: false, message: "An organization with this slug already exists" });
      }
      return res.status(500).json({ success: false, message: "Failed to create organization" });
    }
  });

  router.patch("/:id", readAuthorization, requireOrganizationAdminOrPlatform, async (req, res) => {
    const { id } = req.params;
    if (!ID_PATTERN.test(id)) return res.status(400).json({ success: false, message: "Organization ID is invalid" });
    const validationError = validateFields(req.body, { partial: true });
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    const targetId = req.isPlatformAdmin ? id : req.user.organizationId;
    if (!req.isPlatformAdmin && id !== targetId) return res.status(404).json({ success: false, message: "Organization not found" });

    try {
      const result = await prismaClient.organization.updateMany({
        where: { id: targetId },
        data: normalizedFields(req.body),
      });
      if (result.count === 0) return res.status(404).json({ success: false, message: "Organization not found" });

      const organization = await prismaClient.organization.findUnique({
        where: { id: targetId },
        select: SAFE_ORGANIZATION_FIELDS,
      });
      return res.json({ success: true, data: organization });
    } catch (error) {
      if (error && error.code === "P2002") {
        return res.status(409).json({ success: false, message: "An organization with this slug already exists" });
      }
      return res.status(500).json({ success: false, message: "Failed to update organization" });
    }
  });

  router.delete("/:id", platformAdmin, async (req, res) => {
    const { id } = req.params;
    if (!ID_PATTERN.test(id)) return res.status(400).json({ success: false, message: "Organization ID is invalid" });

    try {
      const result = await prismaClient.organization.deleteMany({ where: { id } });
      if (result.count === 0) return res.status(404).json({ success: false, message: "Organization not found" });
      return res.json({ success: true, message: "Organization deleted" });
    } catch (error) {
      if (error && error.code === "P2003") {
        return res.status(409).json({ success: false, message: "Organization still has related records" });
      }
      return res.status(500).json({ success: false, message: "Failed to delete organization" });
    }
  });

  return router;
}

module.exports = createOrganizationRouter;
