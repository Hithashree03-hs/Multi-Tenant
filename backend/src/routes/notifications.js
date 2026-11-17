const express = require("express");
const createAuthMiddleware = require("../middleware/authenticate");
const requireRole = require("../middleware/authorizeRoles");

const SAFE_NOTIFICATION_FIELDS = {
  id: true,
  type: true,
  title: true,
  message: true,
  resourceType: true,
  resourceId: true,
  readAt: true,
  createdAt: true,
  actor: { select: { id: true, name: true, role: true } },
};

function parsePagination(query) {
  const pageText = query.page === undefined ? "1" : query.page;
  const limitText = query.limit === undefined ? "20" : query.limit;
  if (typeof pageText !== "string" || !/^\d+$/.test(pageText) || typeof limitText !== "string" || !/^\d+$/.test(limitText)) return null;
  const page = Number(pageText);
  const limit = Number(limitText);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  return { page, limit };
}

function createNotificationsRouter(prismaClient, options = {}) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(options.jwtSecret, { resolvePrincipal: options.resolvePrincipal });
  const requireAuthenticated = requireRole("ADMIN", "FACULTY", "STUDENT");

  router.get("/", authenticate, requireAuthenticated, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    if (req.query.unread !== undefined && !["true", "false"].includes(req.query.unread)) return res.status(400).json({ success: false, message: "Unread filter must be true or false" });
    const where = {
      organizationId: req.user.organizationId,
      recipientId: req.user.id,
      ...(req.query.unread === "true" ? { readAt: null } : req.query.unread === "false" ? { readAt: { not: null } } : {}),
    };
    try {
      const [notifications, total, unreadCount] = await Promise.all([
        prismaClient.notification.findMany({
          where,
          select: SAFE_NOTIFICATION_FIELDS,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          skip: (pagination.page - 1) * pagination.limit,
          take: pagination.limit,
        }),
        prismaClient.notification.count({ where }),
        prismaClient.notification.count({ where: { organizationId: req.user.organizationId, recipientId: req.user.id, readAt: null } }),
      ]);
      return res.json({ success: true, data: notifications, unreadCount, pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch notifications" });
    }
  });

  router.patch("/read-all", authenticate, requireAuthenticated, async (req, res) => {
    if (req.body !== undefined && (req.body === null || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length !== 0)) {
      return res.status(400).json({ success: false, message: "Request body must be empty" });
    }
    try {
      const result = await prismaClient.notification.updateMany({
        where: { organizationId: req.user.organizationId, recipientId: req.user.id, readAt: null },
        data: { readAt: new Date() },
      });
      return res.json({ success: true, data: { markedRead: result.count } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to update notifications" });
    }
  });

  router.patch("/:id/read", authenticate, requireAuthenticated, async (req, res) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.id)) return res.status(400).json({ success: false, message: "Notification ID is invalid" });
    if (req.body !== undefined && (req.body === null || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length !== 0)) {
      return res.status(400).json({ success: false, message: "Request body must be empty" });
    }
    try {
      const result = await prismaClient.notification.updateMany({
        where: { id: req.params.id, organizationId: req.user.organizationId, recipientId: req.user.id, readAt: null },
        data: { readAt: new Date() },
      });
      const notification = await prismaClient.notification.findFirst({
        where: { id: req.params.id, organizationId: req.user.organizationId, recipientId: req.user.id },
        select: SAFE_NOTIFICATION_FIELDS,
      });
      if (!notification) return res.status(404).json({ success: false, message: "Notification not found" });
      return res.json({ success: true, data: notification, changed: result.count === 1 });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to update notification" });
    }
  });

  return router;
}

module.exports = createNotificationsRouter;
