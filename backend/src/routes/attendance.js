const express = require("express");
const createAuthMiddleware = require("../middleware/authenticate");
const requireRole = require("../middleware/authorizeRoles");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ATTENDANCE_STATUSES = new Set(["PRESENT", "ABSENT", "LATE", "EXCUSED"]);
const SAFE_SESSION_FIELDS = {
  id: true, organizationId: true, courseId: true, createdById: true,
  title: true, startsAt: true, endsAt: true, createdAt: true, updatedAt: true,
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDate(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return { valid: true, date: null };
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    return { valid: false };
  }
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

function createAttendanceRouter(prismaClient, options = {}) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(options.jwtSecret, { resolvePrincipal: options.resolvePrincipal });
  const requireManager = requireRole("ADMIN", "FACULTY");
  const requireStudent = requireRole("STUDENT");
  const requireAdmin = requireRole("ADMIN");

  async function findManageableSession(user, sessionId) {
    const session = await prismaClient.attendanceSession.findFirst({
      where: { id: sessionId, organizationId: user.organizationId },
      select: SAFE_SESSION_FIELDS,
    });
    if (!session) return null;
    if (user.role === "FACULTY") {
      const ownedCourse = await prismaClient.course.findFirst({
        where: { id: session.courseId, organizationId: user.organizationId, facultyId: user.id },
        select: { id: true },
      });
      if (!ownedCourse) return null;
    }
    return session;
  }

  function validateSessionBody(body, { partial = false } = {}) {
    const allowed = new Set(["courseId", "title", "startsAt", "endsAt"]);
    if (!isObject(body) || !Object.keys(body).every((key) => allowed.has(key))) return "Only courseId, title, startsAt, and endsAt are allowed";
    if (partial && Object.keys(body).length === 0) return "At least one field is required";
    if (!partial && (typeof body.courseId !== "string" || typeof body.title !== "string" || body.startsAt === undefined)) {
      return "Course, title, and start date are required";
    }
    if (body.courseId !== undefined && (typeof body.courseId !== "string" || !ID_PATTERN.test(body.courseId))) return "Course ID is invalid";
    if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160)) return "Title must be between 1 and 160 characters";
    const start = body.startsAt === undefined ? null : parseDate(body.startsAt);
    if (start && !start.valid) return "startsAt must be an ISO date-time with a timezone";
    const end = body.endsAt === undefined ? null : parseDate(body.endsAt, { optional: true });
    if (end && !end.valid) return "endsAt must be null or an ISO date-time with a timezone";
    if (start && start.valid && end && end.valid && end.date && end.date <= start.date) return "endsAt must be later than startsAt";
    return null;
  }

  router.get("/sessions", authenticate, requireManager, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    const where = {
      organizationId: req.user.organizationId,
      ...(req.user.role === "FACULTY" ? { course: { is: { facultyId: req.user.id } } } : {}),
    };
    try {
      const [sessions, total] = await Promise.all([
        prismaClient.attendanceSession.findMany({
          where, select: SAFE_SESSION_FIELDS,
          orderBy: [{ startsAt: "desc" }, { id: "asc" }],
          skip: (pagination.page - 1) * pagination.limit, take: pagination.limit,
        }),
        prismaClient.attendanceSession.count({ where }),
      ]);
      return res.json({ success: true, data: sessions, pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch attendance sessions" });
    }
  });

  router.post("/sessions", authenticate, requireManager, async (req, res) => {
    const validationError = validateSessionBody(req.body);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    try {
      const course = await prismaClient.course.findFirst({
        where: {
          id: req.body.courseId,
          organizationId: req.user.organizationId,
          ...(req.user.role === "FACULTY" ? { facultyId: req.user.id } : {}),
        },
        select: { id: true },
      });
      if (!course) return res.status(404).json({ success: false, message: "Course not found" });
      const startsAt = parseDate(req.body.startsAt).date;
      const endsAt = parseDate(req.body.endsAt, { optional: true }).date;
      const session = await prismaClient.attendanceSession.create({
        data: {
          courseId: course.id,
          organizationId: req.user.organizationId,
          createdById: req.user.id,
          title: req.body.title.trim(),
          startsAt,
          endsAt,
        },
        select: SAFE_SESSION_FIELDS,
      });
      return res.status(201).json({ success: true, data: session });
    } catch (error) {
      if (error && error.code === "P2003") return res.status(400).json({ success: false, message: "A related record is invalid for your organization" });
      return res.status(500).json({ success: false, message: "Failed to create attendance session" });
    }
  });

  router.patch("/sessions/:id", authenticate, requireManager, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Session ID is invalid" });
    const validationError = validateSessionBody(req.body, { partial: true });
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    try {
      const session = await findManageableSession(req.user, req.params.id);
      if (!session) return res.status(404).json({ success: false, message: "Attendance session not found" });
      if (req.body.courseId !== undefined && req.body.courseId !== session.courseId) return res.status(400).json({ success: false, message: "A session cannot be moved to another course" });
      const start = req.body.startsAt === undefined ? session.startsAt : parseDate(req.body.startsAt).date;
      const end = req.body.endsAt === undefined ? session.endsAt : parseDate(req.body.endsAt, { optional: true }).date;
      if (end && end <= start) return res.status(400).json({ success: false, message: "endsAt must be later than startsAt" });
      const data = {};
      if (req.body.title !== undefined) data.title = req.body.title.trim();
      if (req.body.startsAt !== undefined) data.startsAt = start;
      if (req.body.endsAt !== undefined) data.endsAt = end;
      const result = await prismaClient.attendanceSession.updateMany({
        where: { id: session.id, organizationId: req.user.organizationId }, data,
      });
      if (!result.count) return res.status(404).json({ success: false, message: "Attendance session not found" });
      const updated = await prismaClient.attendanceSession.findFirst({ where: { id: session.id, organizationId: req.user.organizationId }, select: SAFE_SESSION_FIELDS });
      return res.json({ success: true, data: updated });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to update attendance session" });
    }
  });

  router.delete("/sessions/:id", authenticate, requireAdmin, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Session ID is invalid" });
    try {
      const result = await prismaClient.attendanceSession.deleteMany({ where: { id: req.params.id, organizationId: req.user.organizationId } });
      if (!result.count) return res.status(404).json({ success: false, message: "Attendance session not found" });
      return res.json({ success: true, message: "Attendance session deleted" });
    } catch (error) {
      if (error && error.code === "P2003") return res.status(409).json({ success: false, message: "Session has attendance records and cannot be deleted" });
      return res.status(500).json({ success: false, message: "Failed to delete attendance session" });
    }
  });

  router.get("/sessions/:id/records", authenticate, requireManager, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Session ID is invalid" });
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    try {
      const session = await findManageableSession(req.user, req.params.id);
      if (!session) return res.status(404).json({ success: false, message: "Attendance session not found" });
      const where = { sessionId: session.id, organizationId: req.user.organizationId };
      const [records, total] = await Promise.all([
        prismaClient.attendanceRecord.findMany({
          where,
          select: {
            id: true, sessionId: true, courseId: true, status: true, markedAt: true,
            enrollment: { select: { student: { select: { id: true, name: true, email: true, role: true } } } },
          },
          orderBy: [{ markedAt: "asc" }, { id: "asc" }],
          skip: (pagination.page - 1) * pagination.limit, take: pagination.limit,
        }),
        prismaClient.attendanceRecord.count({ where }),
      ]);
      return res.json({ success: true, data: records, pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch attendance records" });
    }
  });

  router.post("/sessions/:id/records", authenticate, requireManager, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Session ID is invalid" });
    if (!isObject(req.body) || Object.keys(req.body).some((key) => !["studentId", "status"].includes(key)) || !ID_PATTERN.test(req.body.studentId || "") || !ATTENDANCE_STATUSES.has(req.body.status)) {
      return res.status(400).json({ success: false, message: "A valid studentId and attendance status are required" });
    }
    try {
      const session = await findManageableSession(req.user, req.params.id);
      if (!session) return res.status(404).json({ success: false, message: "Attendance session not found" });
      const enrollment = await prismaClient.enrollment.findFirst({
        where: { courseId: session.courseId, studentId: req.body.studentId, organizationId: req.user.organizationId },
        select: { id: true },
      });
      if (!enrollment) return res.status(404).json({ success: false, message: "Enrolled student not found" });
      const recordKey = { sessionId: session.id, enrollmentId: enrollment.id };
      const existing = await prismaClient.attendanceRecord.findFirst({
        where: { ...recordKey, organizationId: req.user.organizationId },
        select: { id: true },
      });
      const record = await prismaClient.attendanceRecord.upsert({
        where: { sessionId_enrollmentId: recordKey },
        create: {
          organizationId: req.user.organizationId,
          sessionId: session.id,
          courseId: session.courseId,
          enrollmentId: enrollment.id,
          markedById: req.user.id,
          status: req.body.status,
        },
        update: { status: req.body.status, markedById: req.user.id, markedAt: new Date() },
        select: { id: true, sessionId: true, courseId: true, enrollmentId: true, status: true, markedAt: true, updatedAt: true },
      });
      return res.status(existing ? 200 : 201).json({ success: true, data: record, created: !existing });
    } catch (error) {
      if (error && error.code === "P2002") return res.status(409).json({ success: false, message: "Attendance has already been recorded for this student and session" });
      if (error && error.code === "P2003") return res.status(400).json({ success: false, message: "A related attendance record is invalid" });
      return res.status(500).json({ success: false, message: "Failed to record attendance" });
    }
  });

  router.patch("/records/:id", authenticate, requireManager, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Attendance record ID is invalid" });
    if (!isObject(req.body) || Object.keys(req.body).length !== 1 || !ATTENDANCE_STATUSES.has(req.body.status)) return res.status(400).json({ success: false, message: "Only a valid attendance status may be changed" });
    try {
      const record = await prismaClient.attendanceRecord.findFirst({
        where: { id: req.params.id, organizationId: req.user.organizationId },
        select: { id: true, sessionId: true },
      });
      if (!record) return res.status(404).json({ success: false, message: "Attendance record not found" });
      const session = await findManageableSession(req.user, record.sessionId);
      if (!session) return res.status(404).json({ success: false, message: "Attendance record not found" });
      const updated = await prismaClient.attendanceRecord.updateMany({
        where: { id: record.id, sessionId: session.id, organizationId: req.user.organizationId },
        data: { status: req.body.status },
      });
      if (!updated.count) return res.status(404).json({ success: false, message: "Attendance record not found" });
      const safe = await prismaClient.attendanceRecord.findFirst({
        where: { id: record.id, organizationId: req.user.organizationId },
        select: { id: true, sessionId: true, courseId: true, status: true, markedAt: true, updatedAt: true },
      });
      return res.json({ success: true, data: safe });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to update attendance record" });
    }
  });

  router.delete("/records/:id", authenticate, requireManager, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Attendance record ID is invalid" });
    try {
      const record = await prismaClient.attendanceRecord.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId }, select: { id: true, sessionId: true } });
      if (!record || !(await findManageableSession(req.user, record.sessionId))) return res.status(404).json({ success: false, message: "Attendance record not found" });
      const result = await prismaClient.attendanceRecord.deleteMany({ where: { id: record.id, organizationId: req.user.organizationId } });
      if (!result.count) return res.status(404).json({ success: false, message: "Attendance record not found" });
      return res.json({ success: true, message: "Attendance record deleted" });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to delete attendance record" });
    }
  });

  router.get("/me", authenticate, requireStudent, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    const where = { organizationId: req.user.organizationId, enrollment: { is: { studentId: req.user.id, organizationId: req.user.organizationId } } };
    try {
      const [records, total] = await Promise.all([
        prismaClient.attendanceRecord.findMany({
          where,
          select: {
            id: true, status: true, markedAt: true,
            session: { select: { id: true, title: true, startsAt: true, endsAt: true, course: { select: { id: true, code: true, title: true } } } },
          },
          orderBy: [{ markedAt: "desc" }, { id: "asc" }],
          skip: (pagination.page - 1) * pagination.limit, take: pagination.limit,
        }),
        prismaClient.attendanceRecord.count({ where }),
      ]);
      return res.json({ success: true, data: records, pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch attendance" });
    }
  });

  router.get("/reports/course/:courseId", authenticate, requireManager, async (req, res) => {
    if (!ID_PATTERN.test(req.params.courseId)) return res.status(400).json({ success: false, message: "Course ID is invalid" });
    try {
      const course = await prismaClient.course.findFirst({
        where: {
          id: req.params.courseId,
          organizationId: req.user.organizationId,
          ...(req.user.role === "FACULTY" ? { facultyId: req.user.id } : {}),
        },
        select: { id: true, code: true, title: true },
      });
      if (!course) return res.status(404).json({ success: false, message: "Course not found" });
      const grouped = await prismaClient.attendanceRecord.groupBy({
        by: ["status"], where: { courseId: course.id, organizationId: req.user.organizationId }, _count: { _all: true },
      });
      const totals = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
      for (const item of grouped) totals[item.status] = item._count._all;
      return res.json({ success: true, data: { course, totals, total: Object.values(totals).reduce((sum, count) => sum + count, 0) } });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to create attendance report" });
    }
  });

  return router;
}

module.exports = createAttendanceRouter;
