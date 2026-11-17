const express = require("express");
const createAuthMiddleware = require("../middleware/authenticate");
const requireRole = require("../middleware/authorizeRoles");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const ALLOWED_STATUSES = new Set(["DRAFT", "PUBLISHED", "ARCHIVED"]);
const SAFE_COURSE_FIELDS = {
  id: true,
  code: true,
  title: true,
  description: true,
  capacity: true,
  status: true,
  organizationId: true,
  departmentId: true,
  facultyId: true,
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

function safeCourse(course) {
  return {
    id: course.id,
    code: course.code,
    title: course.title,
    description: course.description,
    capacity: course.capacity,
    status: course.status,
    organizationId: course.organizationId,
    departmentId: course.departmentId,
    facultyId: course.facultyId,
    createdAt: course.createdAt,
    updatedAt: course.updatedAt,
  };
}

function validateBody(body, { partial = false } = {}) {
  const allowed = new Set(["code", "title", "description", "capacity", "departmentId", "facultyId", "status"]);
  if (!isObject(body)) return "Request body must be a JSON object";
  if (!Object.keys(body).every((key) => allowed.has(key))) {
    return "Only course fields are allowed; organization is assigned from your account";
  }
  if (partial && Object.keys(body).length === 0) return "At least one field is required";
  if (!partial && (typeof body.code !== "string" || typeof body.title !== "string" || typeof body.departmentId !== "string")) {
    return "Code, title, and departmentId are required";
  }
  if (body.code !== undefined && typeof body.code !== "string") return "Code must be a string";
  if (body.title !== undefined && typeof body.title !== "string") return "Title must be a string";
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
    return "Description must be a string or null";
  }
  if (body.departmentId !== undefined && typeof body.departmentId !== "string") return "Department ID must be a string";
  if (body.facultyId !== undefined && body.facultyId !== null && typeof body.facultyId !== "string") {
    return "Faculty ID must be a string or null";
  }
  if (body.capacity !== undefined && (!Number.isSafeInteger(body.capacity) || body.capacity < 1 || body.capacity > 10000)) {
    return "Capacity must be an integer between 1 and 10000";
  }
  if (body.status !== undefined && (typeof body.status !== "string" || !ALLOWED_STATUSES.has(body.status))) {
    return "Status must be DRAFT, PUBLISHED, or ARCHIVED";
  }
  if (body.code !== undefined) {
    const code = body.code.trim().toUpperCase();
    if (!code || code.length > 32 || !CODE_PATTERN.test(code)) return "Code must contain letters, numbers, and single hyphens only";
  }
  if (body.title !== undefined && (!body.title.trim() || body.title.trim().length > 160)) {
    return "Title must be between 1 and 160 characters";
  }
  if (typeof body.description === "string" && body.description.length > 4000) {
    return "Description must be 4000 characters or fewer";
  }
  if (body.departmentId !== undefined && !ID_PATTERN.test(body.departmentId)) return "Department ID is invalid";
  if (typeof body.facultyId === "string" && !ID_PATTERN.test(body.facultyId)) return "Faculty ID is invalid";
  return null;
}

function normalizedBody(body) {
  const data = {};
  if (body.code !== undefined) data.code = body.code.trim().toUpperCase();
  if (body.title !== undefined) data.title = body.title.trim();
  if (body.description !== undefined) data.description = body.description === null ? null : body.description.trim();
  if (body.capacity !== undefined) data.capacity = body.capacity;
  if (body.departmentId !== undefined) data.departmentId = body.departmentId;
  if (body.facultyId !== undefined) data.facultyId = body.facultyId;
  if (body.status !== undefined) data.status = body.status;
  return data;
}

function createCourseRouter(prismaClient, options = {}) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(options.jwtSecret, {
    resolvePrincipal: options.resolvePrincipal,
  });
  const requireManager = requireRole("ADMIN", "FACULTY");
  const requireAdmin = requireRole("ADMIN");
  const requireStudent = requireRole("STUDENT");

  async function findVisibleCourse(req, id) {
    const where = { id, organizationId: req.user.organizationId };
    if (req.user.role === "FACULTY") where.facultyId = req.user.id;
    if (req.user.role === "STUDENT") where.status = "PUBLISHED";
    return prismaClient.course.findFirst({ where, select: SAFE_COURSE_FIELDS });
  }

  async function validateRelatedRecords(data, organizationId) {
    const department = await prismaClient.department.findFirst({
      where: { id: data.departmentId, organizationId },
      select: { id: true },
    });
    if (!department) return "Department not found in your organization";
    if (data.facultyId) {
      const faculty = await prismaClient.user.findFirst({
        where: { id: data.facultyId, organizationId, role: "FACULTY" },
        select: { id: true },
      });
      if (!faculty) return "Faculty member not found in your organization";
    }
    return null;
  }

  router.get("/", authenticate, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    if (req.query.departmentId !== undefined && (typeof req.query.departmentId !== "string" || !ID_PATTERN.test(req.query.departmentId))) {
      return res.status(400).json({ success: false, message: "Department ID is invalid" });
    }
    const where = { organizationId: req.user.organizationId };
    if (req.user.role === "STUDENT") where.status = "PUBLISHED";
    if (req.user.role === "FACULTY") where.facultyId = req.user.id;
    if (req.query.departmentId) where.departmentId = req.query.departmentId;
    const { page, limit } = pagination;

    try {
      const [courses, total] = await Promise.all([
        prismaClient.course.findMany({
          where,
          select: SAFE_COURSE_FIELDS,
          orderBy: [{ title: "asc" }, { id: "asc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prismaClient.course.count({ where }),
      ]);
      return res.json({
        success: true,
        data: courses.map(safeCourse),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch courses" });
    }
  });

  router.get("/:id", authenticate, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Course ID is invalid" });
    try {
      const course = await findVisibleCourse(req, req.params.id);
      if (!course) return res.status(404).json({ success: false, message: "Course not found" });
      return res.json({ success: true, data: safeCourse(course) });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch course" });
    }
  });

  router.post("/", authenticate, requireManager, async (req, res) => {
    const validationError = validateBody(req.body);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    const data = normalizedBody(req.body);

    if (req.user.role === "FACULTY") {
      if (data.facultyId !== undefined && data.facultyId !== req.user.id) {
        return res.status(403).json({ success: false, message: "Faculty can assign courses only to themselves" });
      }
      data.facultyId = req.user.id;
      if (data.status === "ARCHIVED") return res.status(403).json({ success: false, message: "Only an administrator can archive a course" });
    }
    const relatedError = await validateRelatedRecords(data, req.user.organizationId);
    if (relatedError) return res.status(400).json({ success: false, message: relatedError });

    try {
      const course = await prismaClient.course.create({
        data: {
          ...data,
          status: data.status || "DRAFT",
          capacity: data.capacity || 100,
          organizationId: req.user.organizationId,
        },
        select: SAFE_COURSE_FIELDS,
      });
      return res.status(201).json({ success: true, data: safeCourse(course) });
    } catch (error) {
      if (error && error.code === "P2002") return res.status(409).json({ success: false, message: "A course with this code already exists in your organization" });
      if (error && error.code === "P2003") return res.status(400).json({ success: false, message: "A related record is invalid for your organization" });
      return res.status(500).json({ success: false, message: "Failed to create course" });
    }
  });

  router.patch("/:id", authenticate, requireManager, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Course ID is invalid" });
    const validationError = validateBody(req.body, { partial: true });
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    let current;
    try {
      current = await prismaClient.course.findFirst({
        where: { id: req.params.id, organizationId: req.user.organizationId },
        select: SAFE_COURSE_FIELDS,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch course" });
    }
    if (!current) return res.status(404).json({ success: false, message: "Course not found" });
    if (req.user.role === "FACULTY" && current.facultyId !== req.user.id) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }
    const data = normalizedBody(req.body);
    if (req.user.role === "FACULTY") {
      if (data.facultyId !== undefined && data.facultyId !== req.user.id) {
        return res.status(403).json({ success: false, message: "Faculty cannot reassign a course" });
      }
      if (data.status === "ARCHIVED") return res.status(403).json({ success: false, message: "Only an administrator can archive a course" });
    }
    if (data.departmentId !== undefined || data.facultyId !== undefined) {
      const relatedError = await validateRelatedRecords({
        departmentId: data.departmentId || current.departmentId,
        facultyId: data.facultyId === undefined ? current.facultyId : data.facultyId,
      }, req.user.organizationId);
      if (relatedError) return res.status(400).json({ success: false, message: relatedError });
    }

    try {
      const course = await prismaClient.$transaction(async (tx) => {
        if (data.capacity !== undefined) {
          const enrollmentCount = await tx.enrollment.count({
            where: { courseId: current.id, organizationId: req.user.organizationId },
          });
          if (data.capacity < enrollmentCount) throw new Error("CAPACITY_BELOW_ENROLLMENT");
        }
        const result = await tx.course.updateMany({
          where: {
            id: current.id,
            organizationId: req.user.organizationId,
            ...(req.user.role === "FACULTY" ? { facultyId: req.user.id } : {}),
          },
          data,
        });
        if (result.count === 0) throw new Error("COURSE_NOT_FOUND");
        return tx.course.findFirst({
          where: { id: current.id, organizationId: req.user.organizationId },
          select: SAFE_COURSE_FIELDS,
        });
      }, { isolationLevel: "Serializable" });
      return res.json({ success: true, data: safeCourse(course) });
    } catch (error) {
      if (error && error.message === "COURSE_NOT_FOUND") return res.status(404).json({ success: false, message: "Course not found" });
      if (error && error.message === "CAPACITY_BELOW_ENROLLMENT") return res.status(409).json({ success: false, message: "Capacity cannot be lower than the current enrollment" });
      if (error && error.code === "P2002") return res.status(409).json({ success: false, message: "A course with this code already exists in your organization" });
      if (error && error.code === "P2003") return res.status(400).json({ success: false, message: "A related record is invalid for your organization" });
      if (error && error.code === "P2034") return res.status(409).json({ success: false, message: "The course changed during the update; please retry" });
      return res.status(500).json({ success: false, message: "Failed to update course" });
    }
  });

  router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Course ID is invalid" });
    try {
      const result = await prismaClient.course.deleteMany({
        where: { id: req.params.id, organizationId: req.user.organizationId },
      });
      if (result.count === 0) return res.status(404).json({ success: false, message: "Course not found" });
      return res.json({ success: true, message: "Course deleted" });
    } catch (error) {
      if (error && error.code === "P2003") return res.status(409).json({ success: false, message: "Course has enrollments and cannot be deleted" });
      return res.status(500).json({ success: false, message: "Failed to delete course" });
    }
  });

  router.get("/:id/enrollments", authenticate, requireManager, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Course ID is invalid" });
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    const { page, limit } = pagination;
    try {
      const whereCourse = {
        id: req.params.id,
        organizationId: req.user.organizationId,
        ...(req.user.role === "FACULTY" ? { facultyId: req.user.id } : {}),
      };
      const course = await prismaClient.course.findFirst({ where: whereCourse, select: { id: true } });
      if (!course) return res.status(404).json({ success: false, message: "Course not found" });
      const whereEnrollments = { courseId: course.id, organizationId: req.user.organizationId };
      const [enrollments, total] = await Promise.all([
        prismaClient.enrollment.findMany({
          where: whereEnrollments,
          select: {
            id: true,
            courseId: true,
            studentId: true,
            enrolledAt: true,
            student: { select: { id: true, name: true, email: true, role: true, organizationId: true } },
          },
          orderBy: [{ enrolledAt: "asc" }, { id: "asc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prismaClient.enrollment.count({ where: whereEnrollments }),
      ]);
      return res.json({
        success: true,
        data: enrollments,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch course enrollments" });
    }
  });

  router.post("/:id/enroll", authenticate, requireStudent, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Course ID is invalid" });
    try {
      const enrollment = await prismaClient.$transaction(async (tx) => {
        const course = await tx.course.findFirst({
          where: { id: req.params.id, organizationId: req.user.organizationId, status: "PUBLISHED" },
          select: { id: true, capacity: true },
        });
        if (!course) throw new Error("COURSE_NOT_AVAILABLE");
        const existing = await tx.enrollment.findFirst({
          where: { courseId: course.id, studentId: req.user.id, organizationId: req.user.organizationId },
          select: { id: true },
        });
        if (existing) throw new Error("ALREADY_ENROLLED");
        const enrollmentCount = await tx.enrollment.count({
          where: { courseId: course.id, organizationId: req.user.organizationId },
        });
        if (enrollmentCount >= course.capacity) throw new Error("COURSE_FULL");
        return tx.enrollment.create({
          data: {
            courseId: course.id,
            studentId: req.user.id,
            organizationId: req.user.organizationId,
          },
          select: { id: true, courseId: true, studentId: true, organizationId: true, enrolledAt: true },
        });
      }, { isolationLevel: "Serializable" });
      return res.status(201).json({ success: true, data: enrollment });
    } catch (error) {
      if (error && error.message === "COURSE_NOT_AVAILABLE") return res.status(404).json({ success: false, message: "Course not found" });
      if (error && error.message === "ALREADY_ENROLLED") return res.status(409).json({ success: false, message: "You are already enrolled in this course" });
      if (error && error.message === "COURSE_FULL") return res.status(409).json({ success: false, message: "Course has reached capacity" });
      if (error && (error.code === "P2002" || error.code === "P2034")) return res.status(409).json({ success: false, message: "Enrollment could not be completed; please retry" });
      return res.status(500).json({ success: false, message: "Failed to enroll in course" });
    }
  });

  router.delete("/:id/enroll", authenticate, requireStudent, async (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ success: false, message: "Course ID is invalid" });
    try {
      const result = await prismaClient.enrollment.deleteMany({
        where: {
          courseId: req.params.id,
          studentId: req.user.id,
          organizationId: req.user.organizationId,
        },
      });
      if (result.count === 0) return res.status(404).json({ success: false, message: "Enrollment not found" });
      return res.json({ success: true, message: "Enrollment cancelled" });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to cancel enrollment" });
    }
  });

  router.delete("/:courseId/enrollments/:studentId", authenticate, requireAdmin, async (req, res) => {
    if (!ID_PATTERN.test(req.params.courseId) || !ID_PATTERN.test(req.params.studentId)) {
      return res.status(400).json({ success: false, message: "Course or student ID is invalid" });
    }
    try {
      const whereCourse = { id: req.params.courseId, organizationId: req.user.organizationId };
      const course = await prismaClient.course.findFirst({ where: whereCourse, select: { id: true } });
      if (!course) return res.status(404).json({ success: false, message: "Course not found" });
      const result = await prismaClient.enrollment.deleteMany({
        where: {
          courseId: course.id,
          studentId: req.params.studentId,
          organizationId: req.user.organizationId,
        },
      });
      if (result.count === 0) return res.status(404).json({ success: false, message: "Enrollment not found" });
      return res.json({ success: true, message: "Enrollment removed" });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to remove enrollment" });
    }
  });

  return router;
}

module.exports = createCourseRouter;
