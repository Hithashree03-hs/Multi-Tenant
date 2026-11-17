const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");

const JWT_SECRET = "course-tests-use-a-local-only-jwt-secret";
const servers = new Set();

function matches(record, where) {
  return Object.entries(where || {}).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) return value.in.includes(record[key]);
    return record[key] === value;
  });
}

function makePrisma({ role = "ADMIN", courses = [], enrollments = [], overrides = {} } = {}) {
  const courseRows = [...courses];
  const enrollmentRows = [...enrollments];
  const users = [
    { id: "faculty-a", organizationId: "org-a", role: "FACULTY" },
    { id: "student-a", organizationId: "org-a", role: "STUDENT" },
  ];
  const prisma = {
    organization: { findMany: async () => [], findUnique: async () => null },
    department: {
      findMany: async () => [],
      findFirst: async ({ where }) => where.id === "dept-a" && where.organizationId === "org-a" ? { id: "dept-a" } : null,
      count: async () => 0,
    },
    user: {
      findFirst: async ({ where }) => users.find((user) => matches(user, where)) || null,
      findMany: async () => [], findUnique: async () => null, create: async () => ({}),
      updateMany: async () => ({ count: 0 }), count: async () => 0,
    },
    course: {
      findMany: async ({ where }) => courseRows.filter((course) => matches(course, where)),
      findFirst: async ({ where }) => courseRows.find((course) => matches(course, where)) || null,
      create: async ({ data }) => {
        const course = { id: `course-${courseRows.length + 1}`, ...data, createdAt: new Date(), updatedAt: new Date() };
        courseRows.push(course);
        return course;
      },
      updateMany: async ({ where, data }) => {
        const course = courseRows.find((row) => matches(row, where));
        if (!course) return { count: 0 };
        Object.assign(course, data);
        return { count: 1 };
      },
      deleteMany: async ({ where }) => {
        const index = courseRows.findIndex((row) => matches(row, where));
        if (index < 0) return { count: 0 };
        courseRows.splice(index, 1);
        return { count: 1 };
      },
      count: async ({ where }) => courseRows.filter((course) => matches(course, where)).length,
    },
    enrollment: {
      findMany: async ({ where }) => enrollmentRows.filter((row) => matches(row, where)),
      findFirst: async ({ where }) => enrollmentRows.find((row) => matches(row, where)) || null,
      create: async ({ data }) => {
        const row = { id: `enrollment-${enrollmentRows.length + 1}`, ...data, enrolledAt: new Date() };
        enrollmentRows.push(row);
        return row;
      },
      deleteMany: async ({ where }) => {
        const index = enrollmentRows.findIndex((row) => matches(row, where));
        if (index < 0) return { count: 0 };
        enrollmentRows.splice(index, 1);
        return { count: 1 };
      },
      count: async ({ where }) => enrollmentRows.filter((row) => matches(row, where)).length,
    },
    $transaction: async (callback) => callback(prisma),
  };
  for (const [model, methods] of Object.entries(overrides)) {
    if (model === "$transaction") prisma.$transaction = methods;
    else Object.assign(prisma[model], methods);
  }
  return { prisma, courseRows, enrollmentRows };
}

async function startServer(prisma, role = "ADMIN") {
  const app = createApp(prisma, {
    jwtSecret: JWT_SECRET,
    resolvePrincipal: async (id, organizationId) =>
      id === "user-a" && organizationId === "org-a" ? { id, organizationId, role } : null,
  });
  const server = app.listen(0);
  servers.add(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(baseUrl, method, path, { role = "ADMIN", body } = {}) {
  const token = jwt.sign(
    { role, organizationId: "org-a" },
    JWT_SECRET,
    { subject: "user-a", expiresIn: "1h", algorithm: "HS256" },
  );
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

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
});

test("administrator creates a course with server-derived organization and validated tenant links", async () => {
  let createArgs;
  const { prisma } = makePrisma({ overrides: { course: {
    create: async (args) => {
      createArgs = args;
      return { id: "course-new", ...args.data, createdAt: new Date(), updatedAt: new Date() };
    },
  } } });
  const baseUrl = await startServer(prisma);
  const { response, json } = await request(baseUrl, "POST", "/api/courses", {
    body: {
      code: " cs-101 ", title: " Introduction to CS ", departmentId: "dept-a", facultyId: "faculty-a",
      organizationId: "org-b", capacity: 30, status: "PUBLISHED",
    },
  });

  assert.equal(response.status, 400); // organizationId is not an accepted body field.
  assert.equal(createArgs, undefined);

  const valid = await request(baseUrl, "POST", "/api/courses", {
    body: { code: " cs-101 ", title: " Introduction to CS ", departmentId: "dept-a", facultyId: "faculty-a", capacity: 30, status: "PUBLISHED" },
  });
  assert.equal(valid.response.status, 201);
  assert.equal(createArgs.data.organizationId, "org-a");
  assert.equal(createArgs.data.code, "CS-101");
  assert.equal(createArgs.data.title, "Introduction to CS");
  assert.equal(json.success, false);
});

test("faculty courses are assigned to the current faculty member only", async () => {
  let createCalled = false;
  const { prisma } = makePrisma({ overrides: { course: { create: async () => { createCalled = true; return {}; } } } });
  const baseUrl = await startServer(prisma, "FACULTY");
  const { response } = await request(baseUrl, "POST", "/api/courses", {
    role: "FACULTY",
    body: { code: "CS-101", title: "Intro", departmentId: "dept-a", facultyId: "faculty-other" },
  });
  assert.equal(response.status, 403);
  assert.equal(createCalled, false);
});

test("student course lists use the authenticated tenant and published status", async () => {
  let listArgs;
  const { prisma } = makePrisma({ overrides: { course: {
    findMany: async (args) => { listArgs = args; return []; },
    count: async () => 0,
  } } });
  const baseUrl = await startServer(prisma, "STUDENT");
  const { response } = await request(baseUrl, "GET", "/api/courses?organizationId=org-b", { role: "STUDENT" });
  assert.equal(response.status, 200);
  assert.deepEqual(listArgs.where, { organizationId: "org-a", status: "PUBLISHED" });
});

test("student enrollment is tenant-bound and uses a serializable capacity check", async () => {
  let transactionOptions;
  const { prisma } = makePrisma({ overrides: {
    $transaction: async (callback, options) => {
      transactionOptions = options;
      return callback(prisma);
    },
  } });
  const baseUrl = await startServer(prisma, "STUDENT");
  const { response, json } = await request(baseUrl, "POST", "/api/courses/course-a/enroll", { role: "STUDENT" });

  assert.equal(response.status, 404);
  assert.deepEqual(transactionOptions, { isolationLevel: "Serializable" });
  assert.equal(json.message, "Course not found");
});

test("student can enroll only in a published course in the authenticated tenant", async () => {
  const { prisma, enrollmentRows } = makePrisma({ courses: [
    { id: "course-a", organizationId: "org-a", status: "PUBLISHED", capacity: 3 },
  ] });
  const baseUrl = await startServer(prisma, "STUDENT");
  const { response, json } = await request(baseUrl, "POST", "/api/courses/course-a/enroll", { role: "STUDENT" });

  assert.equal(response.status, 201);
  assert.equal(enrollmentRows.length, 1);
  assert.equal(enrollmentRows[0].organizationId, "org-a");
  assert.equal(enrollmentRows[0].studentId, "user-a");
  assert.equal(json.data.organizationId, "org-a");
});

test("faculty can view assigned rosters but cannot change enrollments", async () => {
  let deleteCalled = false;
  const { prisma } = makePrisma({
    courses: [{ id: "course-a", organizationId: "org-a", facultyId: "user-a", status: "PUBLISHED" }],
    enrollments: [{ id: "enrollment-a", courseId: "course-a", studentId: "student-a", organizationId: "org-a" }],
    overrides: { enrollment: { deleteMany: async () => { deleteCalled = true; return { count: 1 }; } } },
  });
  const baseUrl = await startServer(prisma, "FACULTY");
  const roster = await request(baseUrl, "GET", "/api/courses/course-a/enrollments", { role: "FACULTY" });
  const removed = await request(baseUrl, "DELETE", "/api/courses/course-a/enrollments/student-a", { role: "FACULTY" });
  assert.equal(roster.response.status, 200);
  assert.equal(removed.response.status, 403);
  assert.equal(deleteCalled, false);
});

test("students may cancel only their own enrollment", async () => {
  const { prisma, enrollmentRows } = makePrisma({ enrollments: [
    { id: "mine", courseId: "course-a", studentId: "user-a", organizationId: "org-a" },
    { id: "theirs", courseId: "course-a", studentId: "student-a", organizationId: "org-a" },
  ] });
  const baseUrl = await startServer(prisma, "STUDENT");
  const { response } = await request(baseUrl, "DELETE", "/api/courses/course-a/enroll", { role: "STUDENT" });
  assert.equal(response.status, 200);
  assert.deepEqual(enrollmentRows.map(({ id }) => id), ["theirs"]);
});

test("enrollment rejects a full course and duplicate enrollment", async () => {
  const publishedCourse = { id: "course-a", organizationId: "org-a", status: "PUBLISHED", capacity: 1 };
  const fullDb = makePrisma({ courses: [publishedCourse], enrollments: [{ id: "existing", courseId: "course-a", studentId: "someone-else", organizationId: "org-a" }] });
  const fullBaseUrl = await startServer(fullDb.prisma, "STUDENT");
  const full = await request(fullBaseUrl, "POST", "/api/courses/course-a/enroll", { role: "STUDENT" });
  assert.equal(full.response.status, 409);
  assert.equal(full.json.message, "Course has reached capacity");

  const duplicateDb = makePrisma({ courses: [{ ...publishedCourse, capacity: 10 }], enrollments: [{ id: "mine", courseId: "course-a", studentId: "user-a", organizationId: "org-a" }] });
  const duplicateBaseUrl = await startServer(duplicateDb.prisma, "STUDENT");
  const duplicate = await request(duplicateBaseUrl, "POST", "/api/courses/course-a/enroll", { role: "STUDENT" });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.json.message, "You are already enrolled in this course");
});

test("faculty cannot read or change courses owned by another faculty member", async () => {
  let updateCalled = false;
  const { prisma } = makePrisma({ courses: [{ id: "course-a", organizationId: "org-a", facultyId: "faculty-other", status: "PUBLISHED" }], overrides: {
    course: { updateMany: async () => { updateCalled = true; return { count: 1 }; } },
  } });
  const baseUrl = await startServer(prisma, "FACULTY");
  const { response } = await request(baseUrl, "PATCH", "/api/courses/course-a", { role: "FACULTY", body: { title: "Hijacked" } });
  assert.equal(response.status, 404);
  assert.equal(updateCalled, false);
});

test("course capacity cannot be reduced below current enrollment", async () => {
  const { prisma, courseRows } = makePrisma({
    courses: [{ id: "course-a", organizationId: "org-a", facultyId: null, capacity: 2 }],
    enrollments: [
      { id: "enrollment-a", courseId: "course-a", studentId: "student-a", organizationId: "org-a" },
      { id: "enrollment-b", courseId: "course-a", studentId: "student-b", organizationId: "org-a" },
    ],
  });
  const baseUrl = await startServer(prisma);
  const { response, json } = await request(baseUrl, "PATCH", "/api/courses/course-a", { body: { capacity: 1 } });
  assert.equal(response.status, 409);
  assert.equal(json.message, "Capacity cannot be lower than the current enrollment");
  assert.equal(courseRows[0].capacity, 2);
});

test("partial course edits update the requested tenant course and preserve all omitted fields", async () => {
  const original = {
    id: "course-a", code: "BIO-101", title: "Biology", description: "Foundations", capacity: 40,
    status: "PUBLISHED", departmentId: "dept-a", facultyId: "faculty-a", organizationId: "org-a",
  };
  const otherCourse = { ...original, id: "course-b", code: "CHEM-101", title: "Chemistry" };
  let updateArgs;
  const { prisma, courseRows } = makePrisma({ courses: [original, otherCourse], overrides: { course: {
    updateMany: async ({ where, data }) => {
      updateArgs = { where, data };
      const selected = courseRows.find((course) => matches(course, where));
      if (!selected) return { count: 0 };
      Object.assign(selected, data);
      return { count: 1 };
    },
  } } });
  const baseUrl = await startServer(prisma);

  const updated = await request(baseUrl, "PATCH", "/api/courses/course-a", { body: { title: "Cell Biology" } });
  assert.equal(updated.response.status, 200);
  assert.deepEqual(updateArgs, {
    where: { id: "course-a", organizationId: "org-a" },
    data: { title: "Cell Biology" },
  });
  assert.equal(updated.json.data.title, "Cell Biology");
  assert.deepEqual(courseRows[0], { ...original, title: "Cell Biology" });
  assert.equal(courseRows[1].title, "Chemistry");

  const fetched = await request(baseUrl, "GET", "/api/courses/course-a");
  assert.equal(fetched.response.status, 200);
  assert.deepEqual(fetched.json.data, { ...original, title: "Cell Biology" });

  const invalid = await request(baseUrl, "PATCH", "/api/courses/course-a", { body: { title: "   " } });
  assert.equal(invalid.response.status, 400);
  assert.equal(courseRows[0].title, "Cell Biology");
});

test("course partial updates reject foreign-tenant IDs and disallowed fields", async () => {
  let updateCalled = false;
  const { prisma } = makePrisma({ overrides: { course: {
    findFirst: async ({ where }) => where.organizationId === "org-a" ? null : null,
    updateMany: async () => { updateCalled = true; return { count: 1 }; },
  } } });
  const baseUrl = await startServer(prisma);
  const foreign = await request(baseUrl, "PATCH", "/api/courses/foreign-course", { body: { title: "Changed" } });
  const overposted = await request(baseUrl, "PATCH", "/api/courses/course-a", { body: { title: "Changed", organizationId: "org-b" } });

  assert.equal(foreign.response.status, 404);
  assert.equal(overposted.response.status, 400);
  assert.equal(updateCalled, false);
});

test("students cannot create or modify courses", async () => {
  const { prisma } = makePrisma();
  const baseUrl = await startServer(prisma, "STUDENT");
  const created = await request(baseUrl, "POST", "/api/courses", {
    role: "STUDENT", body: { code: "CS-101", title: "Intro", departmentId: "dept-a" },
  });
  const updated = await request(baseUrl, "PATCH", "/api/courses/course-a", {
    role: "STUDENT", body: { title: "Changed" },
  });
  const deleted = await request(baseUrl, "DELETE", "/api/courses/course-a", { role: "STUDENT" });
  assert.equal(created.response.status, 403);
  assert.equal(updated.response.status, 403);
  assert.equal(deleted.response.status, 403);
});
