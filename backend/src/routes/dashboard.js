const express = require("express");
const createAuthMiddleware = require("../middleware/authenticate");
const requireRole = require("../middleware/authorizeRoles");

function createDashboardRouter(prismaClient, options = {}) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(options.jwtSecret, { resolvePrincipal: options.resolvePrincipal });
  const requireAuthenticated = requireRole("ADMIN", "FACULTY", "STUDENT");

  router.get("/", authenticate, requireAuthenticated, async (req, res) => {
    const organizationId = req.user.organizationId;
    const userId = req.user.id;
    try {
      const unreadNotifications = prismaClient.notification.count({ where: { organizationId, recipientId: userId, readAt: null } });
      let data;
      if (req.user.role === "ADMIN") {
        const [users, faculty, students, departments, courses, enrollments, attendanceRecords, projects, tasks, projectStatuses, taskStatuses, unreadCount] = await Promise.all([
          prismaClient.user.count({ where: { organizationId } }),
          prismaClient.user.count({ where: { organizationId, role: "FACULTY" } }),
          prismaClient.user.count({ where: { organizationId, role: "STUDENT" } }),
          prismaClient.department.count({ where: { organizationId } }),
          prismaClient.course.count({ where: { organizationId } }),
          prismaClient.enrollment.count({ where: { organizationId } }),
          prismaClient.attendanceRecord.count({ where: { organizationId } }),
          prismaClient.project.count({ where: { organizationId } }),
          prismaClient.task.count({ where: { organizationId } }),
          prismaClient.project.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
          prismaClient.task.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
          unreadNotifications,
        ]);
        data = { users, faculty, students, departments, courses, enrollments, attendanceRecords, projects, tasks, projectStatuses: summarizeStatuses(projectStatuses), taskStatuses: summarizeStatuses(taskStatuses), unreadNotifications: unreadCount };
      } else if (req.user.role === "FACULTY") {
        const facultyCourse = { organizationId, facultyId: userId };
        const facultyProjects = { organizationId, OR: [{ ownerId: userId }, { members: { some: { organizationId, userId } } }] };
        const facultyTasks = { organizationId, OR: [{ assigneeId: userId }, { createdById: userId }] };
        const [courses, enrollments, attendanceSessions, attendanceRecords, projects, assignedTasks, projectStatuses, taskStatuses, unreadCount] = await Promise.all([
          prismaClient.course.count({ where: facultyCourse }),
          prismaClient.enrollment.count({ where: { organizationId, course: { is: facultyCourse } } }),
          prismaClient.attendanceSession.count({ where: { organizationId, course: { is: facultyCourse } } }),
          prismaClient.attendanceRecord.count({ where: { organizationId, session: { is: { organizationId, course: { is: facultyCourse } } } } }),
          prismaClient.project.count({ where: facultyProjects }),
          prismaClient.task.count({ where: facultyTasks }),
          prismaClient.project.groupBy({ by: ["status"], where: facultyProjects, _count: { _all: true } }),
          prismaClient.task.groupBy({ by: ["status"], where: facultyTasks, _count: { _all: true } }),
          unreadNotifications,
        ]);
        data = { courses, enrollments, attendanceSessions, attendanceRecords, projects, assignedTasks, projectStatuses: summarizeStatuses(projectStatuses), taskStatuses: summarizeStatuses(taskStatuses), unreadNotifications: unreadCount };
      } else {
        const studentProjects = { organizationId, members: { some: { organizationId, userId } } };
        const studentTasks = { organizationId, assigneeId: userId };
        const [enrollments, attendanceRecords, projects, assignedTasks, projectStatuses, taskStatuses, unreadCount] = await Promise.all([
          prismaClient.enrollment.count({ where: { organizationId, studentId: userId } }),
          prismaClient.attendanceRecord.count({ where: { organizationId, enrollment: { is: { organizationId, studentId: userId } } } }),
          prismaClient.projectMember.count({ where: { organizationId, userId } }),
          prismaClient.task.count({ where: studentTasks }),
          prismaClient.project.groupBy({ by: ["status"], where: studentProjects, _count: { _all: true } }),
          prismaClient.task.groupBy({ by: ["status"], where: studentTasks, _count: { _all: true } }),
          unreadNotifications,
        ]);
        data = { enrollments, attendanceRecords, projects, assignedTasks, projectStatuses: summarizeStatuses(projectStatuses), taskStatuses: summarizeStatuses(taskStatuses), unreadNotifications: unreadCount };
      }
      return res.json({ success: true, data });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch dashboard summary" });
    }
  });

  return router;
}

function summarizeStatuses(rows) {
  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
}

module.exports = createDashboardRouter;
