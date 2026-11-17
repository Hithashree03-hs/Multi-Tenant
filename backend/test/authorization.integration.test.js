const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("./helpers/integrationDatabaseGuard").loadAndAssertIntegrationDatabase();
const { createApp } = require("../src/app");
const prisma = require("../src/prisma");

const PASSWORD = "integration-only-test-password";
const PASSWORD_HASH = bcrypt.hash(PASSWORD, 4);
const createdStates = [];

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function removeCreatedRecords(created) {
  if (created.attendanceRecordIds.length) await prisma.attendanceRecord.deleteMany({ where: { id: { in: created.attendanceRecordIds } } });
  if (created.attendanceSessionIds.length) await prisma.attendanceSession.deleteMany({ where: { id: { in: created.attendanceSessionIds } } });
  if (created.enrollmentIds.length) await prisma.enrollment.deleteMany({ where: { id: { in: created.enrollmentIds } } });
  if (created.courseIds.length) await prisma.course.deleteMany({ where: { id: { in: created.courseIds } } });
  if (created.departmentIds.length) await prisma.department.deleteMany({ where: { id: { in: created.departmentIds } } });
  if (created.userIds.length) await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  if (created.organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: created.organizationIds } } });
}

function trackResponseId(created, key, result) {
  const id = result.json?.data?.id;
  if (id && !created[key].includes(id)) created[key].push(id);
}

async function withFixture(run) {
  await prisma.$connect();
  const created = {
    organizationIds: [], userIds: [], departmentIds: [], courseIds: [], enrollmentIds: [],
    attendanceSessionIds: [], attendanceRecordIds: [],
  };
  createdStates.push(created);
  let server;

  async function createOrganization(label) {
    const organization = await prisma.organization.create({
      data: { name: `${label} ${suffix}`, slug: `${label.toLowerCase()}-${suffix}` },
      select: { id: true },
    });
    created.organizationIds.push(organization.id);
    return organization;
  }

  async function createUser(organizationId, role, label) {
    const user = await prisma.user.create({
      data: {
        name: `${label} ${suffix}`,
        email: `${label.toLowerCase()}-${suffix}@integration.invalid`,
        password: await PASSWORD_HASH,
        role,
        organizationId,
      },
      select: { id: true, name: true, email: true, role: true, organizationId: true },
    });
    created.userIds.push(user.id);
    return user;
  }

  const suffix = randomUUID().replace(/-/g, "").slice(0, 16);
  const secret = randomBytes(32).toString("hex");
  try {
    const organizationA = await createOrganization("AuthzA");
    const organizationB = await createOrganization("AuthzB");
    const users = {
      adminA: await createUser(organizationA.id, "ADMIN", "admin-a"),
      facultyA: await createUser(organizationA.id, "FACULTY", "faculty-a"),
      facultyOtherA: await createUser(organizationA.id, "FACULTY", "faculty-other-a"),
      studentA: await createUser(organizationA.id, "STUDENT", "student-a"),
      adminB: await createUser(organizationB.id, "ADMIN", "admin-b"),
      facultyB: await createUser(organizationB.id, "FACULTY", "faculty-b"),
      studentB: await createUser(organizationB.id, "STUDENT", "student-b"),
    };

    const app = createApp(prisma, { jwtSecret: secret });
    server = app.listen(0);
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    async function request(user, method, path, body, claims = {}) {
      const token = jwt.sign({
        role: claims.role || user.role,
        organizationId: claims.organizationId || user.organizationId,
      }, secret, { subject: user.id, expiresIn: "1h", algorithm: "HS256" });
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, json: await response.json() };
    }

    const context = {
      created,
      organizationA,
      organizationB,
      users,
      suffix,
      request,
      async createDepartment(organizationId, label) {
        const department = await prisma.department.create({
          data: { name: `${label} ${suffix}`, code: `${label.slice(0, 1)}${suffix.slice(0, 8).toUpperCase()}`, organizationId },
          select: { id: true, name: true, code: true, organizationId: true },
        });
        created.departmentIds.push(department.id);
        return department;
      },
      async createCourse(organizationId, departmentId, facultyId, label) {
        const course = await prisma.course.create({
          data: {
            code: `${label.slice(0, 1)}${suffix.slice(0, 8).toUpperCase()}`,
            title: `${label} ${suffix}`,
            capacity: 20,
            status: "PUBLISHED",
            organizationId,
            departmentId,
            facultyId,
          },
          select: { id: true, code: true, title: true, status: true, organizationId: true, departmentId: true, facultyId: true },
        });
        created.courseIds.push(course.id);
        return course;
      },
      async createEnrollment(organizationId, courseId, studentId) {
        const enrollment = await prisma.enrollment.create({
          data: { organizationId, courseId, studentId },
          select: { id: true },
        });
        created.enrollmentIds.push(enrollment.id);
        return enrollment;
      },
      async createAttendanceSession(organizationId, courseId, creatorId, label) {
        const session = await prisma.attendanceSession.create({
          data: {
            organizationId,
            courseId,
            createdById: creatorId,
            title: `${label} ${suffix}`,
            startsAt: new Date("2026-10-01T10:00:00.000Z"),
          },
          select: { id: true },
        });
        created.attendanceSessionIds.push(session.id);
        return session;
      },
    };

    await run(context);
  } finally {
    await closeServer(server);
    await removeCreatedRecords(created);
  }
}

after(async () => {
  for (const created of createdStates) await removeCreatedRecords(created);
  await prisma.$disconnect();
});

test("PostgreSQL organization settings are writable only by the organization's ADMIN", async () => {
  await withFixture(async ({ organizationA, organizationB, users, suffix, request }) => {
    const updated = await request(users.adminA, "PATCH", `/api/organizations/${organizationA.id}`, {
      name: `Updated Academy ${suffix}`,
      slug: `updated-academy-${suffix}`,
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.json.data.name, `Updated Academy ${suffix}`);
    assert.equal(updated.json.data.slug, `updated-academy-${suffix}`);
    const persistedA = await prisma.organization.findUnique({ where: { id: organizationA.id } });
    assert.equal(persistedA.name, `Updated Academy ${suffix}`);
    assert.equal(persistedA.slug, `updated-academy-${suffix}`);

    for (const user of [users.facultyA, users.studentA]) {
      const denied = await request(user, "PATCH", `/api/organizations/${organizationA.id}`, {
        name: `Unauthorized ${suffix}`,
        slug: `unauthorized-${suffix}`,
      });
      assert.equal(denied.response.status, 403);
    }

    const crossOrganization = await request(users.adminA, "PATCH", `/api/organizations/${organizationB.id}`, {
      name: `Cross Tenant ${suffix}`,
      slug: `cross-tenant-${suffix}`,
    });
    assert.equal(crossOrganization.response.status, 404);
    const persistedB = await prisma.organization.findUnique({ where: { id: organizationB.id } });
    assert.equal(persistedB.name, `AuthzB ${suffix}`);
    assert.equal(persistedB.slug, `authzb-${suffix}`);
  });
});

test("PostgreSQL user account routes limit writes to tenant ADMINs and read faculty to student records", async () => {
  await withFixture(async ({ created, organizationA, users, suffix, request }) => {
    const studentBody = {
      name: `Created Student ${suffix}`,
      email: `created-student-${suffix}@integration.invalid`,
      password: PASSWORD,
      role: "STUDENT",
    };
    const createdAccount = await request(users.adminA, "POST", "/api/users", studentBody);
    trackResponseId(created, "userIds", createdAccount);
    assert.equal(createdAccount.response.status, 201);
    assert.equal(createdAccount.json.data.role, "STUDENT");
    assert.equal(createdAccount.json.data.organizationId, organizationA.id);
    assert.equal(Object.hasOwn(createdAccount.json.data, "password"), false);

    const persistedAccount = await prisma.user.findUnique({ where: { email: studentBody.email } });
    assert.equal(persistedAccount.organizationId, organizationA.id);
    assert.equal(persistedAccount.role, "STUDENT");
    const hashIsBcrypt = typeof persistedAccount.password === "string" && /^\$2[aby]\$/.test(persistedAccount.password);
    assert.equal(hashIsBcrypt, true);
    const hashMatchesInput = await bcrypt.compare(studentBody.password, persistedAccount.password);
    assert.equal(hashMatchesInput, true);

    const updatedAccount = await request(users.adminA, "PATCH", `/api/users/${persistedAccount.id}`, {
      name: `Updated Student ${suffix}`,
    });
    assert.equal(updatedAccount.response.status, 200);
    assert.equal(updatedAccount.json.data.name, `Updated Student ${suffix}`);
    assert.equal((await prisma.user.findUnique({ where: { id: persistedAccount.id } })).name, `Updated Student ${suffix}`);

    const facultyDirectory = await request(users.facultyA, "GET", "/api/users?limit=100");
    assert.equal(facultyDirectory.response.status, 200);
    const facultyVisibleIds = facultyDirectory.json.data.map((user) => user.id).sort();
    assert.deepEqual(facultyVisibleIds, [users.studentA.id, persistedAccount.id].sort());
    assert.ok(facultyDirectory.json.data.every((user) => user.role === "STUDENT" && user.organizationId === organizationA.id));

    const facultyCreate = await request(users.facultyA, "POST", "/api/users", {
      ...studentBody,
      email: `faculty-created-${suffix}@integration.invalid`,
    });
    assert.equal(facultyCreate.response.status, 403);
    const facultyUpdate = await request(users.facultyA, "PATCH", `/api/users/${users.studentA.id}`, { name: "Faculty changed this" });
    assert.equal(facultyUpdate.response.status, 403);

    const staleAdminStudentToken = await request(users.studentA, "GET", "/api/users", undefined, { role: "ADMIN" });
    assert.equal(staleAdminStudentToken.response.status, 403);
    const studentDetail = await request(users.studentA, "GET", `/api/users/${users.studentA.id}`);
    assert.equal(studentDetail.response.status, 403);

    const forbiddenAdminCreate = await request(users.adminA, "POST", "/api/users", {
      ...studentBody,
      email: `tenant-created-admin-${suffix}@integration.invalid`,
      role: "ADMIN",
    });
    assert.equal(forbiddenAdminCreate.response.status, 400);
    const forbiddenAdminPromotion = await request(users.adminA, "PATCH", `/api/users/${users.studentA.id}`, { role: "ADMIN" });
    assert.equal(forbiddenAdminPromotion.response.status, 400);
    const uncreatedAdmin = await prisma.user.findUnique({ where: { email: `tenant-created-admin-${suffix}@integration.invalid` } });
    assert.equal(uncreatedAdmin, null);

    const foreignProfile = await request(users.adminA, "PATCH", `/api/users/${users.studentB.id}`, { name: "Cross tenant" });
    assert.equal(foreignProfile.response.status, 404);
    const unchangedForeign = await prisma.user.findUnique({ where: { id: users.studentB.id } });
    assert.equal(unchangedForeign.name, users.studentB.name);
  });
});

test("PostgreSQL administrative enrollment removal is ADMIN-only and tenant-scoped", async () => {
  await withFixture(async ({ created, organizationA, organizationB, users, createDepartment, createCourse, createEnrollment, request }) => {
    const departmentA = await createDepartment(organizationA.id, "ADept");
    const departmentB = await createDepartment(organizationB.id, "BDept");
    const courseA = await createCourse(organizationA.id, departmentA.id, users.facultyA.id, "ACourse");
    const courseB = await createCourse(organizationB.id, departmentB.id, users.facultyB.id, "BCourse");
    const enrollmentA = await createEnrollment(organizationA.id, courseA.id, users.studentA.id);
    const enrollmentB = await createEnrollment(organizationB.id, courseB.id, users.studentB.id);

    const facultyRemoval = await request(users.facultyA, "DELETE", `/api/courses/${courseA.id}/enrollments/${users.studentA.id}`);
    assert.equal(facultyRemoval.response.status, 403);
    const studentRemoval = await request(users.studentA, "DELETE", `/api/courses/${courseA.id}/enrollments/${users.studentA.id}`);
    assert.equal(studentRemoval.response.status, 403);
    assert.ok(await prisma.enrollment.findUnique({ where: { id: enrollmentA.id } }));

    const otherTenantCourse = await request(users.adminA, "DELETE", `/api/courses/${courseB.id}/enrollments/${users.studentB.id}`);
    assert.equal(otherTenantCourse.response.status, 404);
    const otherTenantStudent = await request(users.adminA, "DELETE", `/api/courses/${courseA.id}/enrollments/${users.studentB.id}`);
    assert.equal(otherTenantStudent.response.status, 404);
    assert.ok(await prisma.enrollment.findUnique({ where: { id: enrollmentB.id } }));

    const adminRemoval = await request(users.adminA, "DELETE", `/api/courses/${courseA.id}/enrollments/${users.studentA.id}`);
    assert.equal(adminRemoval.response.status, 200);
    assert.equal(await prisma.enrollment.findUnique({ where: { id: enrollmentA.id } }), null);
  });
});

test("PostgreSQL departments and courses enforce role and organization write boundaries", async () => {
  await withFixture(async ({ created, organizationA, organizationB, users, suffix, createDepartment, request }) => {
    const departmentA = await createDepartment(organizationA.id, "DeptA");
    const departmentB = await createDepartment(organizationB.id, "DeptB");

    const adminDepartment = await request(users.adminA, "POST", "/api/departments", {
      name: `Created Department ${suffix}`,
      code: `N${suffix.slice(0, 8).toUpperCase()}`,
    });
    trackResponseId(created, "departmentIds", adminDepartment);
    assert.equal(adminDepartment.response.status, 201);
    assert.equal(adminDepartment.json.data.organizationId, organizationA.id);
    const adminDepartmentUpdate = await request(users.adminA, "PATCH", `/api/departments/${adminDepartment.json.data.id}`, {
      name: `Updated Department ${suffix}`,
    });
    assert.equal(adminDepartmentUpdate.response.status, 200);
    assert.equal((await prisma.department.findUnique({ where: { id: adminDepartment.json.data.id } })).name, `Updated Department ${suffix}`);
    const adminDepartmentDelete = await request(users.adminA, "DELETE", `/api/departments/${adminDepartment.json.data.id}`);
    assert.equal(adminDepartmentDelete.response.status, 200);

    const clientOrganizationChoice = await request(users.adminA, "POST", "/api/departments", {
      name: "Client-selected tenant",
      code: `X${suffix.slice(0, 8).toUpperCase()}`,
      organizationId: organizationB.id,
    });
    assert.equal(clientOrganizationChoice.response.status, 400);

    for (const user of [users.facultyA, users.studentA]) {
      const createDenied = await request(user, "POST", "/api/departments", { name: "Forbidden", code: `F${suffix.slice(0, 8).toUpperCase()}` });
      assert.equal(createDenied.response.status, 403);
      const updateDenied = await request(user, "PATCH", `/api/departments/${departmentA.id}`, { name: "Forbidden change" });
      assert.equal(updateDenied.response.status, 403);
      const deleteDenied = await request(user, "DELETE", `/api/departments/${departmentA.id}`);
      assert.equal(deleteDenied.response.status, 403);
    }

    const foreignDepartmentUpdate = await request(users.adminA, "PATCH", `/api/departments/${departmentB.id}`, { name: "Foreign update" });
    assert.equal(foreignDepartmentUpdate.response.status, 404);
    const foreignDepartmentDelete = await request(users.adminA, "DELETE", `/api/departments/${departmentB.id}`);
    assert.equal(foreignDepartmentDelete.response.status, 404);
    assert.equal((await prisma.department.findUnique({ where: { id: departmentB.id } })).name, departmentB.name);

    const adminCourse = await request(users.adminA, "POST", "/api/courses", {
      code: `ADMIN-${suffix.slice(0, 8).toUpperCase()}`,
      title: `Admin Course ${suffix}`,
      departmentId: departmentA.id,
      facultyId: users.facultyA.id,
      status: "PUBLISHED",
    });
    trackResponseId(created, "courseIds", adminCourse);
    assert.equal(adminCourse.response.status, 201);
    assert.equal(adminCourse.json.data.organizationId, organizationA.id);
    const adminCourseUpdate = await request(users.adminA, "PATCH", `/api/courses/${adminCourse.json.data.id}`, { title: `Updated Admin Course ${suffix}` });
    assert.equal(adminCourseUpdate.response.status, 200);

    const facultyCourse = await request(users.facultyA, "POST", "/api/courses", {
      code: `FACULTY-${suffix.slice(0, 8).toUpperCase()}`,
      title: `Faculty Course ${suffix}`,
      departmentId: departmentA.id,
      status: "PUBLISHED",
    });
    trackResponseId(created, "courseIds", facultyCourse);
    assert.equal(facultyCourse.response.status, 201);
    assert.equal(facultyCourse.json.data.facultyId, users.facultyA.id);
    const facultyCourseUpdate = await request(users.facultyA, "PATCH", `/api/courses/${facultyCourse.json.data.id}`, { title: `Updated Faculty Course ${suffix}` });
    assert.equal(facultyCourseUpdate.response.status, 200);

    const facultyCannotReassign = await request(users.facultyA, "PATCH", `/api/courses/${facultyCourse.json.data.id}`, { facultyId: users.facultyOtherA.id });
    assert.equal(facultyCannotReassign.response.status, 403);
    const facultyCannotArchive = await request(users.facultyA, "PATCH", `/api/courses/${facultyCourse.json.data.id}`, { status: "ARCHIVED" });
    assert.equal(facultyCannotArchive.response.status, 403);

    const otherFacultyCourse = await prisma.course.create({
      data: {
        code: `OTHER-${suffix.slice(0, 8).toUpperCase()}`,
        title: `Other Faculty Course ${suffix}`,
        status: "PUBLISHED",
        organizationId: organizationA.id,
        departmentId: departmentA.id,
        facultyId: users.facultyOtherA.id,
      },
      select: { id: true, title: true },
    });
    created.courseIds.push(otherFacultyCourse.id);
    const unassignedFacultyUpdate = await request(users.facultyA, "PATCH", `/api/courses/${otherFacultyCourse.id}`, { title: "Wrong faculty" });
    assert.equal(unassignedFacultyUpdate.response.status, 404);

    const foreignTenantCourse = await prisma.course.create({
      data: {
        code: `FOREIGN-${suffix.slice(0, 8).toUpperCase()}`,
        title: `Foreign Tenant Course ${suffix}`,
        status: "PUBLISHED",
        organizationId: organizationB.id,
        departmentId: departmentB.id,
        facultyId: users.facultyB.id,
      },
      select: { id: true, title: true },
    });
    created.courseIds.push(foreignTenantCourse.id);

    const facultyCannotAssignCourse = await request(users.facultyA, "POST", "/api/courses", {
      code: `DENY-FACULTY-${suffix.slice(0, 8).toUpperCase()}`,
      title: "Wrong faculty assignment",
      departmentId: departmentA.id,
      facultyId: users.facultyOtherA.id,
    });
    assert.equal(facultyCannotAssignCourse.response.status, 403);
    const studentCannotCreateCourse = await request(users.studentA, "POST", "/api/courses", {
      code: `DENY-STUDENT-${suffix.slice(0, 8).toUpperCase()}`,
      title: "Forbidden course",
      departmentId: departmentA.id,
      facultyId: users.facultyA.id,
    });
    assert.equal(studentCannotCreateCourse.response.status, 403);
    const studentUpdate = await request(users.studentA, "PATCH", `/api/courses/${adminCourse.json.data.id}`, { title: "Student changed course" });
    assert.equal(studentUpdate.response.status, 403);
    const studentDelete = await request(users.studentA, "DELETE", `/api/courses/${adminCourse.json.data.id}`);
    assert.equal(studentDelete.response.status, 403);

    const crossTenantCourseUpdate = await request(users.adminA, "PATCH", `/api/courses/${foreignTenantCourse.id}`, { title: "Cross tenant" });
    assert.equal(crossTenantCourseUpdate.response.status, 404);
    const crossTenantCourseDelete = await request(users.adminA, "DELETE", `/api/courses/${foreignTenantCourse.id}`);
    assert.equal(crossTenantCourseDelete.response.status, 404);
    assert.equal((await prisma.course.findUnique({ where: { id: foreignTenantCourse.id } })).title, foreignTenantCourse.title);
    const persistedAdminCourse = await prisma.course.findUnique({ where: { id: adminCourse.json.data.id } });
    assert.equal(persistedAdminCourse.title, `Updated Admin Course ${suffix}`);
    const adminCourseDelete = await request(users.adminA, "DELETE", `/api/courses/${adminCourse.json.data.id}`);
    assert.equal(adminCourseDelete.response.status, 200);
  });
});

test("PostgreSQL attendance access is limited by role, tenant, and faculty course assignment", async () => {
  await withFixture(async ({ created, organizationA, organizationB, users, createDepartment, createCourse, createEnrollment, createAttendanceSession, request }) => {
    const departmentA = await createDepartment(organizationA.id, "AttendA");
    const departmentB = await createDepartment(organizationB.id, "AttendB");
    const courseA = await createCourse(organizationA.id, departmentA.id, users.facultyA.id, "AttendCourseA");
    const courseB = await createCourse(organizationB.id, departmentB.id, users.facultyB.id, "AttendCourseB");
    const enrollment = await createEnrollment(organizationA.id, courseA.id, users.studentA.id);
    const session = await createAttendanceSession(organizationA.id, courseA.id, users.facultyA.id, "Existing Session");

    const studentList = await request(users.studentA, "GET", "/api/attendance/sessions");
    assert.equal(studentList.response.status, 403);
    const studentCreate = await request(users.studentA, "POST", "/api/attendance/sessions", {
      courseId: courseA.id,
      title: "Student session",
      startsAt: "2026-10-01T10:00:00Z",
    });
    assert.equal(studentCreate.response.status, 403);
    const foreignFacultySession = await request(users.facultyA, "POST", "/api/attendance/sessions", {
      courseId: courseB.id,
      title: "Foreign session",
      startsAt: "2026-10-01T10:00:00Z",
    });
    assert.equal(foreignFacultySession.response.status, 404);

    const facultyCreate = await request(users.facultyA, "POST", `/api/attendance/sessions/${session.id}/records`, {
      studentId: users.studentA.id,
      status: "PRESENT",
    });
    trackResponseId(created, "attendanceRecordIds", facultyCreate);
    assert.equal(facultyCreate.response.status, 201);
    const recordId = facultyCreate.json.data.id;

    const studentReadRecords = await request(users.studentA, "GET", `/api/attendance/sessions/${session.id}/records`);
    assert.equal(studentReadRecords.response.status, 403);
    const studentModify = await request(users.studentA, "PATCH", `/api/attendance/records/${recordId}`, { status: "ABSENT" });
    assert.equal(studentModify.response.status, 403);
    const facultyCrossStudent = await request(users.facultyA, "POST", `/api/attendance/sessions/${session.id}/records`, {
      studentId: users.studentB.id,
      status: "ABSENT",
    });
    assert.equal(facultyCrossStudent.response.status, 404);

    const adminUpdate = await request(users.adminA, "PATCH", `/api/attendance/records/${recordId}`, { status: "LATE" });
    assert.equal(adminUpdate.response.status, 200);
    assert.equal(adminUpdate.json.data.status, "LATE");
    const crossOrganizationAdminUpdate = await request(users.adminB, "PATCH", `/api/attendance/records/${recordId}`, { status: "ABSENT" });
    assert.equal(crossOrganizationAdminUpdate.response.status, 404);
    const persisted = await prisma.attendanceRecord.findUnique({ where: { id: recordId } });
    assert.equal(persisted.status, "LATE");

    const ownAttendance = await request(users.studentA, "GET", "/api/attendance/me?organizationId=" + organizationB.id);
    assert.equal(ownAttendance.response.status, 200);
    assert.deepEqual(ownAttendance.json.data.map((record) => record.id), [recordId]);
    const otherStudentAttendance = await request(users.studentB, "GET", "/api/attendance/me?organizationId=" + organizationA.id);
    assert.equal(otherStudentAttendance.response.status, 200);
    assert.deepEqual(otherStudentAttendance.json.data, []);
    assert.ok(await prisma.enrollment.findUnique({ where: { id: enrollment.id } }));
  });
});
