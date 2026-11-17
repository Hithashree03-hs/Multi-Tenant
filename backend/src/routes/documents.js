const express = require("express");
const createAuthMiddleware = require("../middleware/authenticate");
const requireRole = require("../middleware/authorizeRoles");
const { loadProjectAccess, canManageProject } = require("../services/projectAccess");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const SAFE_DOCUMENT_FIELDS = {
  id: true, projectId: true, taskId: true, uploaderId: true,
  originalName: true, contentType: true, sizeBytes: true, createdAt: true,
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePagination(query) {
  const pageText = query.page === undefined ? "1" : query.page;
  const limitText = query.limit === undefined ? "20" : query.limit;
  if (typeof pageText !== "string" || !/^\d+$/.test(pageText) || typeof limitText !== "string" || !/^\d+$/.test(limitText)) return null;
  const page = Number(pageText);
  const limit = Number(limitText);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  return { page, limit };
}

function validFilename(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255 &&
    value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function createDocumentRouter(prismaClient, options = {}) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(options.jwtSecret, { resolvePrincipal: options.resolvePrincipal });
  const requireAuthenticated = requireRole("ADMIN", "FACULTY", "STUDENT");
  const storage = options.storage || null;

  async function requireProject(req, res) {
    if (!ID_PATTERN.test(req.params.projectId)) {
      res.status(400).json({ success: false, message: "Project ID is invalid" });
      return null;
    }
    try {
      const access = await loadProjectAccess(prismaClient, req.user, req.params.projectId);
      if (!access) res.status(404).json({ success: false, message: "Project not found" });
      return access;
    } catch (error) {
      res.status(500).json({ success: false, message: "Failed to authorize project access" });
      return null;
    }
  }

  router.get("/:projectId/documents", authenticate, requireAuthenticated, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    const access = await requireProject(req, res);
    if (!access) return;
    const where = { projectId: access.project.id, organizationId: req.user.organizationId };
    try {
      const [documents, total] = await Promise.all([
        prismaClient.projectDocument.findMany({
          where, select: SAFE_DOCUMENT_FIELDS,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          skip: (pagination.page - 1) * pagination.limit, take: pagination.limit,
        }),
        prismaClient.projectDocument.count({ where }),
      ]);
      return res.json({ success: true, data: documents, pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch project documents" });
    }
  });

  router.post("/documents", authenticate, requireAuthenticated, async (req, res) => {
    const allowed = new Set(["projectId", "taskId", "originalName", "contentType", "sizeBytes", "storageKey"]);
    if (!isObject(req.body) || !Object.keys(req.body).every((key) => allowed.has(key))) return res.status(400).json({ success: false, message: "Only document metadata fields are allowed" });
    const { projectId, taskId, originalName, contentType, sizeBytes, storageKey } = req.body;
    if (typeof projectId !== "string" || !ID_PATTERN.test(projectId) || (taskId !== undefined && taskId !== null && (typeof taskId !== "string" || !ID_PATTERN.test(taskId)))) return res.status(400).json({ success: false, message: "Project or task ID is invalid" });
    if (!validFilename(originalName)) return res.status(400).json({ success: false, message: "Filename is invalid" });
    if (typeof contentType !== "string" || !ALLOWED_TYPES.has(contentType)) return res.status(400).json({ success: false, message: "File type is not allowed" });
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_FILE_BYTES) return res.status(400).json({ success: false, message: "File size must be between 1 byte and 25 MB" });
    if (typeof storageKey !== "string" || !STORAGE_KEY_PATTERN.test(storageKey)) return res.status(400).json({ success: false, message: "Storage reference is invalid" });
    if (!storage || typeof storage.verifyObject !== "function") return res.status(503).json({ success: false, message: "Document storage is not configured" });

    try {
      const access = await loadProjectAccess(prismaClient, req.user, projectId);
      if (!access) return res.status(404).json({ success: false, message: "Project not found" });
      if (taskId) {
        const task = await prismaClient.task.findFirst({ where: { id: taskId, projectId: access.project.id, organizationId: req.user.organizationId }, select: { id: true } });
        if (!task) return res.status(404).json({ success: false, message: "Task not found" });
      }
      // Metadata is recorded only after a trusted storage adapter confirms that
      // an opaque object reference exists in the authenticated tenant/project.
      const verified = await storage.verifyObject({
        organizationId: req.user.organizationId, projectId: access.project.id,
        storageKey, contentType, sizeBytes,
      });
      if (!verified) return res.status(400).json({ success: false, message: "Stored object could not be verified" });
      const document = await prismaClient.projectDocument.create({
        data: {
          projectId: access.project.id,
          taskId: taskId || null,
          organizationId: req.user.organizationId,
          uploaderId: req.user.id,
          originalName,
          contentType,
          sizeBytes,
          storageKey,
        },
        select: SAFE_DOCUMENT_FIELDS,
      });
      return res.status(201).json({ success: true, data: document });
    } catch (error) {
      if (error && error.code === "P2002") return res.status(409).json({ success: false, message: "This stored object is already registered" });
      if (error && error.code === "P2003") return res.status(400).json({ success: false, message: "A related document record is invalid" });
      return res.status(503).json({ success: false, message: "Document storage could not verify the object" });
    }
  });

  router.delete("/:projectId/documents/:documentId", authenticate, requireAuthenticated, async (req, res) => {
    const access = await requireProject(req, res);
    if (!access) return;
    if (!ID_PATTERN.test(req.params.documentId)) return res.status(400).json({ success: false, message: "Document ID is invalid" });
    try {
      const document = await prismaClient.projectDocument.findFirst({
        where: { id: req.params.documentId, projectId: access.project.id, organizationId: req.user.organizationId },
        select: { id: true, storageKey: true, uploaderId: true, contentType: true, sizeBytes: true },
      });
      if (!document) return res.status(404).json({ success: false, message: "Document not found" });
      if (document.uploaderId !== req.user.id && !canManageProject(access)) return res.status(403).json({ success: false, message: "You cannot delete this document" });
      if (!storage || typeof storage.deleteObject !== "function") return res.status(503).json({ success: false, message: "Document storage is not configured" });
      const deletedObject = await storage.deleteObject({ organizationId: req.user.organizationId, projectId: access.project.id, storageKey: document.storageKey });
      if (!deletedObject) return res.status(503).json({ success: false, message: "Stored object could not be deleted" });
      const result = await prismaClient.projectDocument.deleteMany({ where: { id: document.id, projectId: access.project.id, organizationId: req.user.organizationId } });
      if (!result.count) return res.status(404).json({ success: false, message: "Document not found" });
      return res.json({ success: true, message: "Document metadata deleted" });
    } catch (error) {
      return res.status(503).json({ success: false, message: "Document storage operation failed" });
    }
  });

  return router;
}

module.exports = createDocumentRouter;
