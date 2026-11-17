const express = require("express");
const createAuthMiddleware = require("../middleware/authenticate");
const requireRole = require("../middleware/authorizeRoles");
const { loadProjectAccess, canManageProject } = require("../services/projectAccess");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_STATUSES = new Set(["PLANNING", "ACTIVE", "COMPLETED", "ARCHIVED"]);
const TASK_STATUSES = new Set(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]);
const TASK_PRIORITIES = new Set(["LOW", "NORMAL", "HIGH", "URGENT"]);
const SAFE_PROJECT_FIELDS = {
  id: true, organizationId: true, ownerId: true, createdById: true, title: true,
  description: true, status: true, startsAt: true, dueAt: true, createdAt: true, updatedAt: true,
};
const SAFE_TASK_FIELDS = {
  id: true, organizationId: true, projectId: true, createdById: true, assigneeId: true,
  title: true, description: true, status: true, priority: true, dueAt: true, createdAt: true, updatedAt: true,
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDate(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return { valid: true, date: null };
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return { valid: false };
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? { valid: false } : { valid: true, date };
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

function projectBody(body, partial = false) {
  const allowed = new Set(["title", "description", "status", "startsAt", "dueAt"]);
  if (!isObject(body) || !Object.keys(body).every((key) => allowed.has(key))) return "Only title, description, status, startsAt, and dueAt are allowed";
  if (partial && Object.keys(body).length === 0) return "At least one field is required";
  if (!partial && typeof body.title !== "string") return "Title is required";
  if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160)) return "Title must be between 1 and 160 characters";
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") return "Description must be a string or null";
  if (typeof body.description === "string" && body.description.length > 4000) return "Description must be 4000 characters or fewer";
  if (body.status !== undefined && !PROJECT_STATUSES.has(body.status)) return "Project status is invalid";
  for (const key of ["startsAt", "dueAt"]) {
    if (body[key] !== undefined && !parseDate(body[key], { optional: true }).valid) return `${key} must be null or an ISO date-time with a timezone`;
  }
  const start = body.startsAt === undefined ? null : parseDate(body.startsAt, { optional: true }).date;
  const due = body.dueAt === undefined ? null : parseDate(body.dueAt, { optional: true }).date;
  if (start && due && due < start) return "dueAt must not be earlier than startsAt";
  return null;
}

function taskBody(body, partial = false) {
  const allowed = new Set(["title", "description", "status", "priority", "dueAt", "assigneeId"]);
  if (!isObject(body) || !Object.keys(body).every((key) => allowed.has(key))) return "Only task fields are allowed";
  if (partial && Object.keys(body).length === 0) return "At least one field is required";
  if (!partial && typeof body.title !== "string") return "Task title is required";
  if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160)) return "Task title must be between 1 and 160 characters";
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") return "Description must be a string or null";
  if (typeof body.description === "string" && body.description.length > 4000) return "Description must be 4000 characters or fewer";
  if (body.status !== undefined && !TASK_STATUSES.has(body.status)) return "Task status is invalid";
  if (body.priority !== undefined && !TASK_PRIORITIES.has(body.priority)) return "Task priority is invalid";
  if (body.dueAt !== undefined && !parseDate(body.dueAt, { optional: true }).valid) return "dueAt must be null or an ISO date-time with a timezone";
  if (body.assigneeId !== undefined && body.assigneeId !== null && (typeof body.assigneeId !== "string" || !ID_PATTERN.test(body.assigneeId))) return "Assignee ID is invalid";
  return null;
}

function createProjectRouter(prismaClient, options = {}) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(options.jwtSecret, { resolvePrincipal: options.resolvePrincipal });
  const requireAuthenticated = requireRole("ADMIN", "FACULTY", "STUDENT");

  async function requireProject(req, res, projectId) {
    if (!ID_PATTERN.test(projectId)) {
      res.status(400).json({ success: false, message: "Project ID is invalid" });
      return null;
    }
    try {
      const access = await loadProjectAccess(prismaClient, req.user, projectId);
      if (!access) res.status(404).json({ success: false, message: "Project not found" });
      return access;
    } catch (error) {
      res.status(500).json({ success: false, message: "Failed to authorize project access" });
      return null;
    }
  }

  async function isMember(projectId, userId, organizationId) {
    return prismaClient.projectMember.findFirst({
      where: { projectId, userId, organizationId }, select: { id: true },
    });
  }

  async function validateAssignee(projectId, userId, organizationId) {
    if (!userId) return true;
    const member = await isMember(projectId, userId, organizationId);
    return Boolean(member);
  }

  router.get("/", authenticate, requireAuthenticated, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    const where = {
      organizationId: req.user.organizationId,
      ...(req.user.role === "ADMIN" ? {} : { members: { some: { userId: req.user.id, organizationId: req.user.organizationId } } }),
    };
    try {
      const [projects, total] = await Promise.all([
        prismaClient.project.findMany({ where, select: SAFE_PROJECT_FIELDS, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], skip: (pagination.page - 1) * pagination.limit, take: pagination.limit }),
        prismaClient.project.count({ where }),
      ]);
      return res.json({ success: true, data: projects, pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch projects" });
    }
  });

  router.post("/", authenticate, requireAuthenticated, async (req, res) => {
    const error = projectBody(req.body);
    if (error) return res.status(400).json({ success: false, message: error });
    if (req.body.status !== undefined) return res.status(400).json({ success: false, message: "New projects start in PLANNING" });
    const startsAt = req.body.startsAt === undefined || req.body.startsAt === null ? null : parseDate(req.body.startsAt).date;
    const dueAt = req.body.dueAt === undefined || req.body.dueAt === null ? null : parseDate(req.body.dueAt).date;
    try {
      const project = await prismaClient.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            organizationId: req.user.organizationId,
            ownerId: req.user.id,
            createdById: req.user.id,
            title: req.body.title.trim(),
            description: req.body.description === undefined || req.body.description === null ? null : req.body.description.trim(),
            status: "PLANNING",
            startsAt,
            dueAt,
          },
          select: SAFE_PROJECT_FIELDS,
        });
        await tx.projectMember.create({
          data: { organizationId: req.user.organizationId, projectId: created.id, userId: req.user.id },
          select: { id: true },
        });
        return created;
      });
      return res.status(201).json({ success: true, data: project });
    } catch (error) {
      if (error && error.code === "P2003") return res.status(400).json({ success: false, message: "A related project record is invalid" });
      return res.status(500).json({ success: false, message: "Failed to create project" });
    }
  });

  router.get("/:id", authenticate, requireAuthenticated, async (req, res) => {
    const access = await requireProject(req, res, req.params.id);
    if (!access) return;
    try {
      const project = await prismaClient.project.findFirst({ where: { id: access.project.id, organizationId: req.user.organizationId }, select: SAFE_PROJECT_FIELDS });
      if (!project) return res.status(404).json({ success: false, message: "Project not found" });
      return res.json({ success: true, data: project });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch project" });
    }
  });

  router.patch("/:id", authenticate, requireAuthenticated, async (req, res) => {
    const error = projectBody(req.body, true);
    if (error) return res.status(400).json({ success: false, message: error });
    const access = await requireProject(req, res, req.params.id);
    if (!access) return;
    if (!canManageProject(access)) return res.status(403).json({ success: false, message: "Only the project owner or an administrator can update the project" });

    const nextStarts = req.body.startsAt === undefined ? null : parseDate(req.body.startsAt, { optional: true }).date;
    const nextDue = req.body.dueAt === undefined ? null : parseDate(req.body.dueAt, { optional: true }).date;
    const startForValidation = req.body.startsAt === undefined ? undefined : nextStarts;
    const dueForValidation = req.body.dueAt === undefined ? undefined : nextDue;
    const start = startForValidation === undefined ? access.project.startsAt : startForValidation;
    const due = dueForValidation === undefined ? access.project.dueAt : dueForValidation;
    if (start && due && due < start) return res.status(400).json({ success: false, message: "dueAt must not be earlier than startsAt" });
    if (req.body.status && req.body.status !== access.project.status) {
      const transitions = {
        PLANNING: new Set(["ACTIVE", "ARCHIVED"]),
        ACTIVE: new Set(["COMPLETED", "ARCHIVED"]),
        COMPLETED: new Set(["ARCHIVED"]),
        ARCHIVED: new Set(),
      };
      if (!transitions[access.project.status].has(req.body.status)) return res.status(409).json({ success: false, message: "Project status transition is not allowed" });
    }

    const data = {};
    for (const key of ["title", "status"]) if (req.body[key] !== undefined) data[key] = key === "title" ? req.body.title.trim() : req.body.status;
    if (req.body.description !== undefined) data.description = req.body.description === null ? null : req.body.description.trim();
    if (req.body.startsAt !== undefined) data.startsAt = nextStarts;
    if (req.body.dueAt !== undefined) data.dueAt = nextDue;
    try {
      const project = await prismaClient.$transaction(async (tx) => {
        const result = await tx.project.updateMany({ where: { id: access.project.id, organizationId: req.user.organizationId }, data });
        if (!result.count) throw new Error("PROJECT_NOT_FOUND");
        if (req.body.status && req.body.status !== access.project.status && access.project.ownerId !== req.user.id) {
          await tx.notification.create({ data: {
            organizationId: req.user.organizationId,
            recipientId: access.project.ownerId,
            actorId: req.user.id,
            type: "PROJECT_UPDATED",
            title: "Project updated",
            message: "A project status was updated",
            resourceType: "PROJECT",
            resourceId: access.project.id,
          }, select: { id: true } });
        }
        return tx.project.findFirst({ where: { id: access.project.id, organizationId: req.user.organizationId }, select: SAFE_PROJECT_FIELDS });
      });
      return res.json({ success: true, data: project });
    } catch (failure) {
      if (failure && failure.message === "PROJECT_NOT_FOUND") return res.status(404).json({ success: false, message: "Project not found" });
      return res.status(500).json({ success: false, message: "Failed to update project" });
    }
  });

  router.delete("/:id", authenticate, requireAuthenticated, async (req, res) => {
    const access = await requireProject(req, res, req.params.id);
    if (!access) return;
    if (!canManageProject(access)) return res.status(403).json({ success: false, message: "Only the project owner or an administrator can delete the project" });
    try {
      const [tasks, comments, documents] = await Promise.all([
        prismaClient.task.count({ where: { projectId: access.project.id, organizationId: req.user.organizationId } }),
        prismaClient.projectComment.count({ where: { projectId: access.project.id, organizationId: req.user.organizationId } }),
        prismaClient.projectDocument.count({ where: { projectId: access.project.id, organizationId: req.user.organizationId } }),
      ]);
      if (tasks || comments || documents) return res.status(409).json({ success: false, message: "Project has tasks, comments, or documents and cannot be deleted" });
      await prismaClient.$transaction(async (tx) => {
        await tx.projectMember.deleteMany({ where: { projectId: access.project.id, organizationId: req.user.organizationId } });
        const deleted = await tx.project.deleteMany({ where: { id: access.project.id, organizationId: req.user.organizationId } });
        if (!deleted.count) throw new Error("PROJECT_NOT_FOUND");
      });
      return res.json({ success: true, message: "Project deleted" });
    } catch (error) {
      if (error && error.message === "PROJECT_NOT_FOUND") return res.status(404).json({ success: false, message: "Project not found" });
      if (error && error.code === "P2003") return res.status(409).json({ success: false, message: "Project still has related records" });
      return res.status(500).json({ success: false, message: "Failed to delete project" });
    }
  });

  router.get("/:id/members", authenticate, requireAuthenticated, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    const access = await requireProject(req, res, req.params.id);
    if (!access) return;
    const where = { projectId: access.project.id, organizationId: req.user.organizationId };
    try {
      const [members, total] = await Promise.all([
        prismaClient.projectMember.findMany({
          where, select: { id: true, userId: true, addedAt: true, user: { select: { id: true, name: true, email: true, role: true } } },
          orderBy: [{ addedAt: "asc" }, { id: "asc" }], skip: (pagination.page - 1) * pagination.limit, take: pagination.limit,
        }),
        prismaClient.projectMember.count({ where }),
      ]);
      return res.json({ success: true, data: members, pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch project members" });
    }
  });

  router.post("/:id/members", authenticate, requireAuthenticated, async (req, res) => {
    const access = await requireProject(req, res, req.params.id);
    if (!access) return;
    if (!canManageProject(access)) return res.status(403).json({ success: false, message: "Only the project owner or an administrator can add members" });
    if (!isObject(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.userId !== "string" || !ID_PATTERN.test(req.body.userId)) return res.status(400).json({ success: false, message: "A valid userId is required" });
    try {
      const memberUser = await prismaClient.user.findFirst({ where: { id: req.body.userId, organizationId: req.user.organizationId }, select: { id: true } });
      if (!memberUser) return res.status(404).json({ success: false, message: "User not found" });
      const membership = await prismaClient.$transaction(async (tx) => {
        const created = await tx.projectMember.create({
          data: { projectId: access.project.id, userId: memberUser.id, organizationId: req.user.organizationId },
          select: { id: true, projectId: true, userId: true, addedAt: true },
        });
        if (memberUser.id !== req.user.id) {
          await tx.notification.create({ data: {
            organizationId: req.user.organizationId, recipientId: memberUser.id, actorId: req.user.id,
            type: "PROJECT_MEMBER_ADDED", title: "Added to a project", message: "You were added to a project",
            resourceType: "PROJECT", resourceId: access.project.id,
          }, select: { id: true } });
        }
        return created;
      });
      return res.status(201).json({ success: true, data: membership });
    } catch (error) {
      if (error && error.code === "P2002") return res.status(409).json({ success: false, message: "User is already a project member" });
      if (error && error.code === "P2003") return res.status(400).json({ success: false, message: "A related project member is invalid" });
      return res.status(500).json({ success: false, message: "Failed to add project member" });
    }
  });

  router.delete("/:id/members/:userId", authenticate, requireAuthenticated, async (req, res) => {
    const access = await requireProject(req, res, req.params.id);
    if (!access) return;
    if (!canManageProject(access)) return res.status(403).json({ success: false, message: "Only the project owner or an administrator can remove members" });
    if (!ID_PATTERN.test(req.params.userId)) return res.status(400).json({ success: false, message: "User ID is invalid" });
    if (req.params.userId === access.project.ownerId) return res.status(409).json({ success: false, message: "The project owner cannot be removed" });
    try {
      const result = await prismaClient.projectMember.deleteMany({ where: { projectId: access.project.id, userId: req.params.userId, organizationId: req.user.organizationId } });
      if (!result.count) return res.status(404).json({ success: false, message: "Project member not found" });
      return res.json({ success: true, message: "Project member removed" });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to remove project member" });
    }
  });

  router.get("/:projectId/tasks", authenticate, requireAuthenticated, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    const access = await requireProject(req, res, req.params.projectId);
    if (!access) return;
    const where = { projectId: access.project.id, organizationId: req.user.organizationId };
    try {
      const [tasks, total] = await Promise.all([
        prismaClient.task.findMany({ where, select: SAFE_TASK_FIELDS, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (pagination.page - 1) * pagination.limit, take: pagination.limit }),
        prismaClient.task.count({ where }),
      ]);
      return res.json({ success: true, data: tasks, pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch tasks" });
    }
  });

  router.post("/:projectId/tasks", authenticate, requireAuthenticated, async (req, res) => {
    const error = taskBody(req.body);
    if (error) return res.status(400).json({ success: false, message: error });
    if (req.body.status !== undefined) return res.status(400).json({ success: false, message: "New tasks start in TODO" });
    const access = await requireProject(req, res, req.params.projectId);
    if (!access) return;
    try {
      if (req.body.assigneeId && !(await validateAssignee(access.project.id, req.body.assigneeId, req.user.organizationId))) return res.status(400).json({ success: false, message: "Assignee must be a member of this project" });
      const task = await prismaClient.$transaction(async (tx) => {
        const created = await tx.task.create({
          data: {
            projectId: access.project.id, organizationId: req.user.organizationId, createdById: req.user.id,
            assigneeId: req.body.assigneeId || null, title: req.body.title.trim(),
            description: req.body.description === undefined || req.body.description === null ? null : req.body.description.trim(),
            priority: req.body.priority || "NORMAL", dueAt: req.body.dueAt == null ? null : parseDate(req.body.dueAt).date,
            status: "TODO",
          },
          select: SAFE_TASK_FIELDS,
        });
        if (created.assigneeId && created.assigneeId !== req.user.id) {
          await tx.notification.create({ data: {
            organizationId: req.user.organizationId, recipientId: created.assigneeId, actorId: req.user.id,
            type: "TASK_ASSIGNED", title: "Task assigned", message: "A project task was assigned to you",
            resourceType: "TASK", resourceId: created.id,
          }, select: { id: true } });
        }
        return created;
      });
      return res.status(201).json({ success: true, data: task });
    } catch (failure) {
      if (failure && failure.code === "P2003") return res.status(400).json({ success: false, message: "A related task record is invalid" });
      return res.status(500).json({ success: false, message: "Failed to create task" });
    }
  });

  router.get("/:projectId/tasks/:taskId", authenticate, requireAuthenticated, async (req, res) => {
    const access = await requireProject(req, res, req.params.projectId);
    if (!access) return;
    if (!ID_PATTERN.test(req.params.taskId)) return res.status(400).json({ success: false, message: "Task ID is invalid" });
    try {
      const task = await prismaClient.task.findFirst({ where: { id: req.params.taskId, projectId: access.project.id, organizationId: req.user.organizationId }, select: SAFE_TASK_FIELDS });
      if (!task) return res.status(404).json({ success: false, message: "Task not found" });
      return res.json({ success: true, data: task });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch task" });
    }
  });

  router.patch("/:projectId/tasks/:taskId", authenticate, requireAuthenticated, async (req, res) => {
    const error = taskBody(req.body, true);
    if (error) return res.status(400).json({ success: false, message: error });
    const access = await requireProject(req, res, req.params.projectId);
    if (!access) return;
    if (!ID_PATTERN.test(req.params.taskId)) return res.status(400).json({ success: false, message: "Task ID is invalid" });
    try {
      const current = await prismaClient.task.findFirst({ where: { id: req.params.taskId, projectId: access.project.id, organizationId: req.user.organizationId }, select: SAFE_TASK_FIELDS });
      if (!current) return res.status(404).json({ success: false, message: "Task not found" });
      const manager = canManageProject(access) || current.createdById === req.user.id;
      const statusOnly = Object.keys(req.body).length === 1 && req.body.status !== undefined;
      if (!manager && !(statusOnly && current.assigneeId === req.user.id)) return res.status(403).json({ success: false, message: "You cannot update this task" });
      if (req.body.status && req.body.status !== current.status) {
        const transitions = { TODO: new Set(["IN_PROGRESS", "BLOCKED"]), IN_PROGRESS: new Set(["BLOCKED", "DONE"]), BLOCKED: new Set(["IN_PROGRESS", "DONE"]), DONE: new Set() };
        if (!transitions[current.status].has(req.body.status)) return res.status(409).json({ success: false, message: "Task status transition is not allowed" });
      }
      if (req.body.assigneeId && !(await validateAssignee(access.project.id, req.body.assigneeId, req.user.organizationId))) return res.status(400).json({ success: false, message: "Assignee must be a member of this project" });
      const data = {};
      for (const key of ["status", "priority"]) if (req.body[key] !== undefined) data[key] = req.body[key];
      if (req.body.title !== undefined) data.title = req.body.title.trim();
      if (req.body.description !== undefined) data.description = req.body.description === null ? null : req.body.description.trim();
      if (req.body.dueAt !== undefined) data.dueAt = req.body.dueAt === null ? null : parseDate(req.body.dueAt).date;
      if (req.body.assigneeId !== undefined) data.assigneeId = req.body.assigneeId;
      const task = await prismaClient.$transaction(async (tx) => {
        const changed = await tx.task.updateMany({ where: { id: current.id, projectId: access.project.id, organizationId: req.user.organizationId }, data });
        if (!changed.count) throw new Error("TASK_NOT_FOUND");
        if (data.assigneeId && data.assigneeId !== current.assigneeId && data.assigneeId !== req.user.id) {
          await tx.notification.create({ data: {
            organizationId: req.user.organizationId, recipientId: data.assigneeId, actorId: req.user.id,
            type: "TASK_ASSIGNED", title: "Task assigned", message: "A project task was assigned to you",
            resourceType: "TASK", resourceId: current.id,
          }, select: { id: true } });
        }
        return tx.task.findFirst({ where: { id: current.id, projectId: access.project.id, organizationId: req.user.organizationId }, select: SAFE_TASK_FIELDS });
      });
      return res.json({ success: true, data: task });
    } catch (failure) {
      if (failure && failure.message === "TASK_NOT_FOUND") return res.status(404).json({ success: false, message: "Task not found" });
      if (failure && failure.code === "P2003") return res.status(400).json({ success: false, message: "A related task record is invalid" });
      return res.status(500).json({ success: false, message: "Failed to update task" });
    }
  });

  router.delete("/:projectId/tasks/:taskId", authenticate, requireAuthenticated, async (req, res) => {
    const access = await requireProject(req, res, req.params.projectId);
    if (!access) return;
    if (!ID_PATTERN.test(req.params.taskId)) return res.status(400).json({ success: false, message: "Task ID is invalid" });
    try {
      const task = await prismaClient.task.findFirst({ where: { id: req.params.taskId, projectId: access.project.id, organizationId: req.user.organizationId }, select: { id: true, createdById: true } });
      if (!task) return res.status(404).json({ success: false, message: "Task not found" });
      if (!canManageProject(access) && task.createdById !== req.user.id) return res.status(403).json({ success: false, message: "You cannot delete this task" });
      const result = await prismaClient.task.deleteMany({ where: { id: task.id, projectId: access.project.id, organizationId: req.user.organizationId } });
      if (!result.count) return res.status(404).json({ success: false, message: "Task not found" });
      return res.json({ success: true, message: "Task deleted" });
    } catch (error) {
      if (error && error.code === "P2003") return res.status(409).json({ success: false, message: "Task has comments or documents and cannot be deleted" });
      return res.status(500).json({ success: false, message: "Failed to delete task" });
    }
  });

  router.get("/:projectId/comments", authenticate, requireAuthenticated, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    const access = await requireProject(req, res, req.params.projectId);
    if (!access) return;
    if (req.query.taskId !== undefined && (typeof req.query.taskId !== "string" || !ID_PATTERN.test(req.query.taskId))) return res.status(400).json({ success: false, message: "Task ID is invalid" });
    const where = { projectId: access.project.id, organizationId: req.user.organizationId, ...(req.query.taskId ? { taskId: req.query.taskId } : {}) };
    try {
      if (req.query.taskId) {
        const task = await prismaClient.task.findFirst({ where: { id: req.query.taskId, projectId: access.project.id, organizationId: req.user.organizationId }, select: { id: true } });
        if (!task) return res.status(404).json({ success: false, message: "Task not found" });
      }
      const [comments, total] = await Promise.all([
        prismaClient.projectComment.findMany({ where, select: { id: true, projectId: true, taskId: true, authorId: true, content: true, createdAt: true, updatedAt: true, author: { select: { id: true, name: true, role: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (pagination.page - 1) * pagination.limit, take: pagination.limit }),
        prismaClient.projectComment.count({ where }),
      ]);
      return res.json({ success: true, data: comments, pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch comments" });
    }
  });

  router.post("/:projectId/comments", authenticate, requireAuthenticated, async (req, res) => {
    const access = await requireProject(req, res, req.params.projectId);
    if (!access) return;
    if (!isObject(req.body) || Object.keys(req.body).some((key) => !["content", "taskId"].includes(key)) || typeof req.body.content !== "string" || !req.body.content.trim() || req.body.content.trim().length > 2000) return res.status(400).json({ success: false, message: "A comment of 1 to 2000 characters is required" });
    if (req.body.taskId !== undefined && req.body.taskId !== null && (typeof req.body.taskId !== "string" || !ID_PATTERN.test(req.body.taskId))) return res.status(400).json({ success: false, message: "Task ID is invalid" });
    try {
      const taskId = req.body.taskId || null;
      if (taskId) {
        const task = await prismaClient.task.findFirst({ where: { id: taskId, projectId: access.project.id, organizationId: req.user.organizationId }, select: { id: true } });
        if (!task) return res.status(404).json({ success: false, message: "Task not found" });
      }
      const comment = await prismaClient.$transaction(async (tx) => {
        const created = await tx.projectComment.create({
          data: { projectId: access.project.id, organizationId: req.user.organizationId, taskId, authorId: req.user.id, content: req.body.content.trim() },
          select: { id: true, projectId: true, taskId: true, authorId: true, content: true, createdAt: true, updatedAt: true },
        });
        if (access.project.ownerId !== req.user.id) {
          await tx.notification.create({ data: {
            organizationId: req.user.organizationId, recipientId: access.project.ownerId, actorId: req.user.id,
            type: "COMMENT_ADDED", title: "New project comment", message: "A project member added a comment",
            resourceType: "PROJECT_COMMENT", resourceId: created.id,
          }, select: { id: true } });
        }
        return created;
      });
      return res.status(201).json({ success: true, data: comment });
    } catch (error) {
      if (error && error.code === "P2003") return res.status(400).json({ success: false, message: "A related comment record is invalid" });
      return res.status(500).json({ success: false, message: "Failed to create comment" });
    }
  });

  router.patch("/:projectId/comments/:commentId", authenticate, requireAuthenticated, async (req, res) => {
    const access = await requireProject(req, res, req.params.projectId);
    if (!access) return;
    if (!ID_PATTERN.test(req.params.commentId) || !isObject(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.content !== "string" || !req.body.content.trim() || req.body.content.trim().length > 2000) return res.status(400).json({ success: false, message: "Comment ID and content are invalid" });
    try {
      const comment = await prismaClient.projectComment.findFirst({ where: { id: req.params.commentId, projectId: access.project.id, organizationId: req.user.organizationId }, select: { id: true, authorId: true } });
      if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });
      if (comment.authorId !== req.user.id && !canManageProject(access)) return res.status(403).json({ success: false, message: "You cannot edit this comment" });
      const updated = await prismaClient.projectComment.updateMany({ where: { id: comment.id, projectId: access.project.id, organizationId: req.user.organizationId }, data: { content: req.body.content.trim() } });
      if (!updated.count) return res.status(404).json({ success: false, message: "Comment not found" });
      const safe = await prismaClient.projectComment.findFirst({ where: { id: comment.id, projectId: access.project.id, organizationId: req.user.organizationId }, select: { id: true, projectId: true, taskId: true, authorId: true, content: true, createdAt: true, updatedAt: true } });
      return res.json({ success: true, data: safe });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to update comment" });
    }
  });

  router.delete("/:projectId/comments/:commentId", authenticate, requireAuthenticated, async (req, res) => {
    const access = await requireProject(req, res, req.params.projectId);
    if (!access) return;
    if (!ID_PATTERN.test(req.params.commentId)) return res.status(400).json({ success: false, message: "Comment ID is invalid" });
    try {
      const comment = await prismaClient.projectComment.findFirst({ where: { id: req.params.commentId, projectId: access.project.id, organizationId: req.user.organizationId }, select: { id: true, authorId: true } });
      if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });
      if (comment.authorId !== req.user.id && !canManageProject(access)) return res.status(403).json({ success: false, message: "You cannot delete this comment" });
      const deleted = await prismaClient.projectComment.deleteMany({ where: { id: comment.id, projectId: access.project.id, organizationId: req.user.organizationId } });
      if (!deleted.count) return res.status(404).json({ success: false, message: "Comment not found" });
      return res.json({ success: true, message: "Comment deleted" });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to delete comment" });
    }
  });

  return router;
}

module.exports = createProjectRouter;
