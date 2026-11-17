const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("./helpers/integrationDatabaseGuard").loadAndAssertIntegrationDatabase();
const { createApp } = require("../src/app");
const prisma = require("../src/prisma");

const created = {
  organizationIds: [], userIds: [], departmentIds: [], courseIds: [], enrollmentIds: [],
  attendanceSessionIds: [], attendanceRecordIds: [], projectIds: [], taskIds: [],
  commentIds: [], notificationIds: [],
};
let server;

async function call(baseUrl, method, path, bearer, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, json: await response.json() };
}

function makeToken(secret, user, role) {
  return jwt.sign({ role, organizationId: user.organizationId }, secret, { subject: user.id, expiresIn: "1h", algorithm: "HS256" });
}

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (created.commentIds.length) await prisma.projectComment.deleteMany({ where: { id: { in: created.commentIds } } });
  if (created.taskIds.length) await prisma.task.deleteMany({ where: { id: { in: created.taskIds } } });
  if (created.projectIds.length) await prisma.projectMember.deleteMany({ where: { projectId: { in: created.projectIds } } });
  if (created.projectIds.length) await prisma.project.deleteMany({ where: { id: { in: created.projectIds } } });
  if (created.organizationIds.length && created.userIds.length) {
    await prisma.notification.deleteMany({ where: { organizationId: { in: created.organizationIds }, recipientId: { in: created.userIds } } });
  }
  if (created.notificationIds.length) await prisma.notification.deleteMany({ where: { id: { in: created.notificationIds } } });
  if (created.attendanceRecordIds.length) await prisma.attendanceRecord.deleteMany({ where: { id: { in: created.attendanceRecordIds } } });
  if (created.attendanceSessionIds.length) await prisma.attendanceSession.deleteMany({ where: { id: { in: created.attendanceSessionIds } } });
  if (created.enrollmentIds.length) await prisma.enrollment.deleteMany({ where: { id: { in: created.enrollmentIds } } });
  if (created.courseIds.length) await prisma.course.deleteMany({ where: { id: { in: created.courseIds } } });
  if (created.departmentIds.length) await prisma.department.deleteMany({ where: { id: { in: created.departmentIds } } });
  if (created.userIds.length) await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  if (created.organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: created.organizationIds } } });
  await prisma.$disconnect();
});

test("PostgreSQL attendance, project workflows, notifications, dashboards, and tenant relations", async () => {
  await prisma.$connect();
  const suffix = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const passwordHash = await bcrypt.hash("integration-only-test-password", 4);

  const orgA = await prisma.organization.create({ data: { name: `Core A ${suffix}`, slug: `core-a-${suffix}` }, select: { id: true } });
  created.organizationIds.push(orgA.id);
  const orgB = await prisma.organization.create({ data: { name: `Core B ${suffix}`, slug: `core-b-${suffix}` }, select: { id: true } });
  created.organizationIds.push(orgB.id);

  async function createUser(name, role, organizationId, label) {
    const user = await prisma.user.create({
      data: { name, email: `${label}-${suffix}@integration.invalid`, password: passwordHash, role, organizationId },
      select: { id: true, organizationId: true, role: true },
    });
    created.userIds.push(user.id);
    return user;
  }
  const adminA = await createUser("Core Admin A", "ADMIN", orgA.id, "admin-a");
  const facultyA = await createUser("Core Faculty A", "FACULTY", orgA.id, "faculty-a");
  const studentA = await createUser("Core Student A", "STUDENT", orgA.id, "student-a");
  const studentB = await createUser("Core Student B", "STUDENT", orgB.id, "student-b");

  const departmentA = await prisma.department.create({ data: { name: "Core Department A", code: "CORE-A", organizationId: orgA.id }, select: { id: true } });
  created.departmentIds.push(departmentA.id);
  const departmentB = await prisma.department.create({ data: { name: "Core Department B", code: "CORE-B", organizationId: orgB.id }, select: { id: true } });
  created.departmentIds.push(departmentB.id);
  const courseA = await prisma.course.create({
    data: { code: "CORE-A", title: "Tenant A Course", capacity: 10, status: "PUBLISHED", organizationId: orgA.id, departmentId: departmentA.id, facultyId: facultyA.id },
    select: { id: true },
  });
  created.courseIds.push(courseA.id);
  const courseB = await prisma.course.create({
    data: { code: "CORE-B", title: "Tenant B Course", capacity: 10, status: "PUBLISHED", organizationId: orgB.id, departmentId: departmentB.id },
    select: { id: true },
  });
  created.courseIds.push(courseB.id);

  const enrollment = await prisma.enrollment.create({ data: { courseId: courseA.id, organizationId: orgA.id, studentId: studentA.id }, select: { id: true } });
  created.enrollmentIds.push(enrollment.id);

  const app = createApp(prisma, { jwtSecret: secret });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const adminToken = makeToken(secret, adminA, "ADMIN");
  const facultyToken = makeToken(secret, facultyA, "FACULTY");
  const studentToken = makeToken(secret, studentA, "STUDENT");
  const otherTenantToken = makeToken(secret, studentB, "STUDENT");

  const foreignSession = await call(baseUrl, "POST", "/api/attendance/sessions", facultyToken, {
    courseId: courseB.id, title: "Forbidden", startsAt: "2026-10-01T10:00:00Z",
  });
  assert.equal(foreignSession.response.status, 404);

  const sessionResponse = await call(baseUrl, "POST", "/api/attendance/sessions", facultyToken, {
    courseId: courseA.id, title: "Week one", startsAt: "2026-10-01T10:00:00Z",
  });
  assert.equal(sessionResponse.response.status, 201);
  const sessionId = sessionResponse.json.data.id;
  created.attendanceSessionIds.push(sessionId);

  const attendanceBody = { studentId: studentA.id, status: "PRESENT" };
  const recorded = await call(baseUrl, "POST", `/api/attendance/sessions/${sessionId}/records`, facultyToken, attendanceBody);
  assert.equal(recorded.response.status, 201);
  created.attendanceRecordIds.push(recorded.json.data.id);
  for (const status of ["LATE", "ABSENT", "EXCUSED"]) {
    const updated = await call(baseUrl, "POST", `/api/attendance/sessions/${sessionId}/records`, facultyToken, { ...attendanceBody, status });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.json.created, false);
    assert.equal(updated.json.data.id, recorded.json.data.id);
    assert.equal(updated.json.data.status, status);
    assert.equal(await prisma.attendanceRecord.count({ where: { sessionId, organizationId: orgA.id } }), 1);

    const updatedReport = await call(baseUrl, "GET", `/api/attendance/reports/course/${courseA.id}`, facultyToken);
    assert.equal(updatedReport.response.status, 200);
    assert.equal(updatedReport.json.data.total, 1);
    assert.equal(updatedReport.json.data.totals.PRESENT, 0);
    assert.equal(updatedReport.json.data.totals[status], 1);
  }
  const otherStudentRecord = await call(baseUrl, "POST", `/api/attendance/sessions/${sessionId}/records`, facultyToken, { studentId: studentB.id, status: "ABSENT" });
  assert.equal(otherStudentRecord.response.status, 404);

  const ownAttendance = await call(baseUrl, "GET", "/api/attendance/me?organizationId=" + orgB.id, studentToken);
  assert.equal(ownAttendance.response.status, 200);
  assert.deepEqual(ownAttendance.json.data.map((row) => row.id), [recorded.json.data.id]);
  assert.equal(ownAttendance.json.data[0].status, "EXCUSED");
  const report = await call(baseUrl, "GET", `/api/attendance/reports/course/${courseA.id}`, facultyToken);
  assert.equal(report.response.status, 200);
  assert.equal(report.json.data.total, 1);

  const projectResponse = await call(baseUrl, "POST", "/api/projects", adminToken, { title: "Tenant A capstone" });
  assert.equal(projectResponse.response.status, 201);
  const projectId = projectResponse.json.data.id;
  created.projectIds.push(projectId);

  const crossTenantProject = await call(baseUrl, "GET", `/api/projects/${projectId}`, otherTenantToken);
  assert.equal(crossTenantProject.response.status, 404);
  const crossTenantMember = await call(baseUrl, "POST", `/api/projects/${projectId}/members`, adminToken, { userId: studentB.id });
  assert.equal(crossTenantMember.response.status, 404);

  await assert.rejects(
    prisma.projectMember.create({ data: { projectId, userId: studentB.id, organizationId: orgA.id } }),
    (error) => error && error.code === "P2003",
  );

  const addMember = await call(baseUrl, "POST", `/api/projects/${projectId}/members`, adminToken, { userId: studentA.id });
  assert.equal(addMember.response.status, 201);
  const taskResponse = await call(baseUrl, "POST", `/api/projects/${projectId}/tasks`, adminToken, { title: "Prepare report", assigneeId: studentA.id });
  assert.equal(taskResponse.response.status, 201);
  const taskId = taskResponse.json.data.id;
  created.taskIds.push(taskId);

  const invalidAssignee = await call(baseUrl, "POST", `/api/projects/${projectId}/tasks`, adminToken, { title: "Wrong tenant", assigneeId: studentB.id });
  assert.equal(invalidAssignee.response.status, 400);
  const startTask = await call(baseUrl, "PATCH", `/api/projects/${projectId}/tasks/${taskId}`, studentToken, { status: "IN_PROGRESS" });
  assert.equal(startTask.response.status, 200);
  const invalidTransition = await call(baseUrl, "PATCH", `/api/projects/${projectId}/tasks/${taskId}`, studentToken, { status: "TODO" });
  assert.equal(invalidTransition.response.status, 409);

  const comment = await call(baseUrl, "POST", `/api/projects/${projectId}/comments`, studentToken, { content: "Working on the report" });
  assert.equal(comment.response.status, 201);
  assert.equal(comment.json.data.authorId, studentA.id);
  created.commentIds.push(comment.json.data.id);

  const studentNotifications = await call(baseUrl, "GET", "/api/notifications", studentToken);
  assert.equal(studentNotifications.response.status, 200);
  assert.ok(studentNotifications.json.data.some((notification) => notification.type === "TASK_ASSIGNED"));
  const anotherUsersNotification = studentNotifications.json.data.find((notification) => notification.type === "TASK_ASSIGNED");
  const wrongRecipientRead = await call(baseUrl, "PATCH", `/api/notifications/${anotherUsersNotification.id}/read`, otherTenantToken);
  assert.equal(wrongRecipientRead.response.status, 404);
  const readNotification = await call(baseUrl, "PATCH", `/api/notifications/${anotherUsersNotification.id}/read`, studentToken);
  assert.equal(readNotification.response.status, 200);
  assert.ok(readNotification.json.data.readAt);

  const studentDashboard = await call(baseUrl, "GET", "/api/dashboard?organizationId=" + orgB.id, studentToken);
  assert.equal(studentDashboard.response.status, 200);
  assert.equal(studentDashboard.json.data.enrollments, 1);
  assert.equal(studentDashboard.json.data.attendanceRecords, 1);
  assert.equal(studentDashboard.json.data.assignedTasks, 1);

  const adminDashboard = await call(baseUrl, "GET", "/api/dashboard", adminToken);
  assert.equal(adminDashboard.response.status, 200);
  assert.equal(adminDashboard.json.data.students, 1);
  assert.equal(adminDashboard.json.data.courses, 1);
  assert.equal(adminDashboard.json.data.projects, 1);

  const metadataOnly = await call(baseUrl, "POST", "/api/projects/documents", adminToken, {
    projectId, originalName: "notes.pdf", contentType: "application/pdf", sizeBytes: 256, storageKey: "integration-opaque-object-ref",
  });
  assert.equal(metadataOnly.response.status, 503);

  const createdNotifications = await prisma.notification.findMany({
    where: { organizationId: orgA.id, recipientId: { in: [adminA.id, studentA.id] }, resourceId: { in: [projectId, taskId, comment.json.data.id] } },
    select: { id: true },
  });
  created.notificationIds.push(...createdNotifications.map(({ id }) => id));
});
