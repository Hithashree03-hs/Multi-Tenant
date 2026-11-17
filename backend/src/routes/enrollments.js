const express = require("express");
const createAuthMiddleware = require("../middleware/authenticate");
const requireRole = require("../middleware/authorizeRoles");

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

function createEnrollmentRouter(prismaClient, options = {}) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(options.jwtSecret, {
    resolvePrincipal: options.resolvePrincipal,
  });
  const requireStudent = requireRole("STUDENT");

  router.get("/me", authenticate, requireStudent, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, message: "Page or limit is invalid" });
    const where = { studentId: req.user.id, organizationId: req.user.organizationId };
    const { page, limit } = pagination;
    try {
      const [enrollments, total] = await Promise.all([
        prismaClient.enrollment.findMany({
          where,
          select: {
            id: true,
            courseId: true,
            enrolledAt: true,
            course: {
              select: {
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
              },
            },
          },
          orderBy: [{ enrolledAt: "desc" }, { id: "asc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prismaClient.enrollment.count({ where }),
      ]);
      return res.json({
        success: true,
        data: enrollments,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch enrollments" });
    }
  });

  return router;
}

module.exports = createEnrollmentRouter;
