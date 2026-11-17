const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("./helpers/integrationDatabaseGuard").loadAndAssertIntegrationDatabase();
const createApp = require("../src/app").createApp;
const prisma = require("../src/prisma");

const created = { organizationIds: [], userIds: [], departmentIds: [], courseIds: [], enrollmentIds: [] };
let server;

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (created.enrollmentIds.length) await prisma.enrollment.deleteMany({ where: { id: { in: created.enrollmentIds } } });
  if (created.courseIds.length) await prisma.course.deleteMany({ where: { id: { in: created.courseIds } } });
  if (created.departmentIds.length) await prisma.department.deleteMany({ where: { id: { in: created.departmentIds } } });
  if (created.userIds.length) await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  if (created.organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: created.organizationIds } } });
  await prisma.$disconnect();
});

test("PostgreSQL tenant foreign keys and course endpoints isolate enrollment records", async () => {
  await prisma.$connect();
  const suffix = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const passwordHash = await bcrypt.hash("integration-only-test-password", 4);

  const orgA = await prisma.organization.create({ data: { name: `Course Integration A ${suffix}`, slug: `course-a-${suffix}` }, select: { id: true } });
  created.organizationIds.push(orgA.id);
  const orgB = await prisma.organization.create({ data: { name: `Course Integration B ${suffix}`, slug: `course-b-${suffix}` }, select: { id: true } });
  created.organizationIds.push(orgB.id);

  const studentA = await prisma.user.create({
    data: { name: "Course Student A", email: `student-a-${suffix}@integration.invalid`, password: passwordHash, role: "STUDENT", organizationId: orgA.id },
    select: { id: true },
  });
  created.userIds.push(studentA.id);
  const facultyA = await prisma.user.create({
    data: { name: "Course Faculty A", email: `faculty-a-${suffix}@integration.invalid`, password: passwordHash, role: "FACULTY", organizationId: orgA.id },
    select: { id: true },
  });
  created.userIds.push(facultyA.id);
  const studentB = await prisma.user.create({
    data: { name: "Course Student B", email: `student-b-${suffix}@integration.invalid`, password: passwordHash, role: "STUDENT", organizationId: orgB.id },
    select: { id: true },
  });
  created.userIds.push(studentB.id);

  const departmentA = await prisma.department.create({ data: { name: "Course Department A", code: "COURSE-A", organizationId: orgA.id }, select: { id: true } });
  created.departmentIds.push(departmentA.id);
  const departmentB = await prisma.department.create({ data: { name: "Course Department B", code: "COURSE-B", organizationId: orgB.id }, select: { id: true } });
  created.departmentIds.push(departmentB.id);

  const courseA = await prisma.course.create({
    data: { code: "COURSE-A", title: "Tenant A Course", capacity: 3, status: "PUBLISHED", organizationId: orgA.id, departmentId: departmentA.id, facultyId: facultyA.id },
    select: { id: true },
  });
  created.courseIds.push(courseA.id);
  const courseB = await prisma.course.create({
    data: { code: "COURSE-B", title: "Tenant B Course", capacity: 3, status: "PUBLISHED", organizationId: orgB.id, departmentId: departmentB.id },
    select: { id: true },
  });
  created.courseIds.push(courseB.id);

  await assert.rejects(
    prisma.course.create({
      data: { code: "CROSS-ORG", title: "Invalid relation", status: "PUBLISHED", organizationId: orgA.id, departmentId: departmentB.id },
    }),
    (error) => error && error.code === "P2003",
  );

  const app = createApp(prisma, { jwtSecret: secret });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Deliberately put an old ADMIN role in the JWT. The middleware reloads the
  // current STUDENT role and organization from PostgreSQL.
  const staleToken = jwt.sign(
    { role: "ADMIN", organizationId: orgA.id },
    secret,
    { subject: studentA.id, expiresIn: "1h", algorithm: "HS256" },
  );
  const headers = { Authorization: `Bearer ${staleToken}` };

  const listResponse = await fetch(`${baseUrl}/api/courses?organizationId=${orgB.id}`, { headers });
  const listJson = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.deepEqual(listJson.data.map((course) => course.id), [courseA.id]);

  const foreignDetails = await fetch(`${baseUrl}/api/courses/${courseB.id}`, { headers });
  assert.equal(foreignDetails.status, 404);

  const foreignEnrollment = await fetch(`${baseUrl}/api/courses/${courseB.id}/enroll`, { method: "POST", headers });
  assert.equal(foreignEnrollment.status, 404);

  const enrolled = await fetch(`${baseUrl}/api/courses/${courseA.id}/enroll`, { method: "POST", headers });
  const enrollmentJson = await enrolled.json();
  assert.equal(enrolled.status, 201);
  assert.equal(enrollmentJson.data.organizationId, orgA.id);
  created.enrollmentIds.push(enrollmentJson.data.id);

  const ownEnrollments = await fetch(`${baseUrl}/api/enrollments/me?organizationId=${orgB.id}`, { headers });
  const ownEnrollmentsJson = await ownEnrollments.json();
  assert.equal(ownEnrollments.status, 200);
  assert.deepEqual(ownEnrollmentsJson.data.map((record) => record.courseId), [courseA.id]);

  const unchanged = await prisma.enrollment.findMany({ where: { studentId: studentB.id, organizationId: orgB.id } });
  assert.equal(unchanged.length, 0);
});
