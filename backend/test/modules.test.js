const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");

const JWT_SECRET = "campusflow-module-tests-local-secret";
const servers = new Set();

function model(overrides = {}) {
  return {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async ({ data }) => ({ id: "created-row", ...data }), updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }), count: async () => 0, groupBy: async () => [],
    ...overrides,
  };
}

function makePrisma(overrides = {}) {
  const prisma = {
    organization: model(), department: model(), user: model(), course: model(), enrollment: model(),
    attendanceSession: model(), attendanceRecord: model(), project: model(), projectMember: model(), task: model(),
    projectComment: model(), projectDocument: model(), notification: model(),
    $transaction: async (callback) => callback(prisma),
  };
  for (const [name, methods] of Object.entries(overrides)) {
    if (name === "$transaction") prisma.$transaction = methods;
    else Object.assign(prisma[name], methods);
  }
  return prisma;
}

async function startServer(prisma, role = "ADMIN", userId = "user-a", organizationId = "org-a", appOptions = {}) {
  const app = createApp(prisma, {
    jwtSecret: JWT_SECRET,
    resolvePrincipal: async (id, orgId) => id === userId && orgId === organizationId ? { id, role, organizationId } : null,
    ...appOptions,
  });
  const server = app.listen(0);
  servers.add(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function token({ role = "ADMIN", userId = "user-a", organizationId = "org-a", expiresIn = "1h" } = {}) {
  return jwt.sign({ role, organizationId }, JWT_SECRET, { subject: userId, expiresIn, algorithm: "HS256" });
}

async function request(baseUrl, method, path, { bearer = token(), body, withBody = body !== undefined } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(bearer === null ? {} : { Authorization: bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}` }),
      ...(withBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(withBody ? { body: JSON.stringify(body) } : {}),
  });
  return { response, json: await response.json() };
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
});

test("protected modules reject missing, malformed, invalid, and expired bearer tokens with 401", async () => {
  const baseUrl = await startServer(makePrisma());
  const expired = token({ expiresIn: "-1s" });
  for (const bearer of [null, "Basic abc", "Bearer malformed", expired]) {
    const result = await request(baseUrl, "GET", "/api/projects", { bearer });
    assert.equal(result.response.status, 401);
    assert.equal(result.json.success, false);
  }
});

test("students receive 403 for the administrator and faculty attendance session list", async () => {
  const baseUrl = await startServer(makePrisma(), "STUDENT");
  const { response, json } = await request(baseUrl, "GET", "/api/attendance/sessions");
  assert.equal(response.status, 403);
  assert.deepEqual(json, { success: false, message: "Forbidden" });
});

test("project list uses the authenticated organization despite a tenant query parameter", async () => {
  let listArgs;
  let countArgs;
  const prisma = makePrisma({ project: {
    findMany: async (args) => { listArgs = args; return []; },
    count: async (args) => { countArgs = args; return 0; },
  } });
  const baseUrl = await startServer(prisma, "ADMIN");
  const { response } = await request(baseUrl, "GET", "/api/projects?organizationId=org-b");
  assert.equal(response.status, 200);
  assert.deepEqual(listArgs.where, { organizationId: "org-a" });
  assert.deepEqual(countArgs.where, { organizationId: "org-a" });
});

test("cross-organization project details are hidden as not found", async () => {
  let lookup;
  const prisma = makePrisma({ project: { findFirst: async ({ where }) => { lookup = where; return null; } } });
  const baseUrl = await startServer(prisma, "ADMIN");
  const { response, json } = await request(baseUrl, "GET", "/api/projects/project-b");
  assert.equal(response.status, 404);
  assert.deepEqual(lookup, { id: "project-b", organizationId: "org-a" });
  assert.equal(json.message, "Project not found");
});

test("project creation assigns its tenant and owner from the authenticated user", async () => {
  let projectData;
  let memberData;
  const prisma = makePrisma({
    project: { create: async ({ data }) => { projectData = data; return { id: "project-new", ...data, createdAt: new Date(), updatedAt: new Date() }; } },
    projectMember: { create: async ({ data }) => { memberData = data; return { id: "membership-new" }; } },
  });
  const baseUrl = await startServer(prisma, "STUDENT");
  const { response } = await request(baseUrl, "POST", "/api/projects", { body: { title: "Capstone" } });
  assert.equal(response.status, 201);
  assert.equal(projectData.organizationId, "org-a");
  assert.equal(projectData.ownerId, "user-a");
  assert.equal(projectData.createdById, "user-a");
  assert.equal(memberData.organizationId, "org-a");
  assert.equal(memberData.userId, "user-a");
});

test("project member addition rejects a user who is outside the authenticated organization", async () => {
  const project = { id: "project-a", organizationId: "org-a", ownerId: "user-a", status: "ACTIVE", startsAt: null, dueAt: null };
  let memberLookup;
  let created = false;
  const prisma = makePrisma({
    project: { findFirst: async ({ where }) => where.id === project.id && where.organizationId === project.organizationId ? project : null },
    user: { findFirst: async ({ where }) => { memberLookup = where; return null; } },
    projectMember: { create: async () => { created = true; return {}; } },
  });
  const baseUrl = await startServer(prisma);
  const { response } = await request(baseUrl, "POST", "/api/projects/project-a/members", { body: { userId: "user-b" } });
  assert.equal(response.status, 404);
  assert.deepEqual(memberLookup, { id: "user-b", organizationId: "org-a" });
  assert.equal(created, false);
});

test("task assignees must already be members of the same project", async () => {
  const project = { id: "project-a", organizationId: "org-a", ownerId: "user-a", status: "ACTIVE", startsAt: null, dueAt: null };
  let taskCreated = false;
  const prisma = makePrisma({
    project: { findFirst: async () => project },
    projectMember: { findFirst: async () => null },
    task: { create: async () => { taskCreated = true; return {}; } },
  });
  const baseUrl = await startServer(prisma);
  const { response, json } = await request(baseUrl, "POST", "/api/projects/project-a/tasks", { body: { title: "Review", assigneeId: "user-b" } });
  assert.equal(response.status, 400);
  assert.equal(json.message, "Assignee must be a member of this project");
  assert.equal(taskCreated, false);
});

test("project managers cannot skip invalid task state transitions", async () => {
  const project = { id: "project-a", organizationId: "org-a", ownerId: "user-a", status: "ACTIVE", startsAt: null, dueAt: null };
  const task = { id: "task-a", projectId: "project-a", organizationId: "org-a", createdById: "user-a", assigneeId: null, status: "DONE" };
  let updated = false;
  const prisma = makePrisma({
    project: { findFirst: async () => project },
    task: { findFirst: async () => task, updateMany: async () => { updated = true; return { count: 1 }; } },
  });
  const baseUrl = await startServer(prisma);
  const { response, json } = await request(baseUrl, "PATCH", "/api/projects/project-a/tasks/task-a", { body: { status: "TODO" } });
  assert.equal(response.status, 409);
  assert.equal(json.message, "Task status transition is not allowed");
  assert.equal(updated, false);
});

test("comment authorship is taken from the authenticated account", async () => {
  const project = { id: "project-a", organizationId: "org-a", ownerId: "user-a", status: "ACTIVE", startsAt: null, dueAt: null };
  let commentData;
  const prisma = makePrisma({
    project: { findFirst: async () => project },
    projectComment: { create: async ({ data }) => { commentData = data; return { id: "comment-a", ...data, createdAt: new Date(), updatedAt: new Date() }; } },
  });
  const baseUrl = await startServer(prisma, "FACULTY");
  const { response } = await request(baseUrl, "POST", "/api/projects/project-a/comments", { body: { content: "  Reviewed  ", authorId: "attacker" } });
  assert.equal(response.status, 400);
  assert.equal(commentData, undefined);
  const valid = await request(baseUrl, "POST", "/api/projects/project-a/comments", { body: { content: "  Reviewed  " } });
  assert.equal(valid.response.status, 201);
  assert.equal(commentData.authorId, "user-a");
  assert.equal(commentData.organizationId, "org-a");
  assert.equal(commentData.content, "Reviewed");
});

test("faculty attendance sessions are restricted to courses assigned to them", async () => {
  let courseWhere;
  let sessionCreate = false;
  const prisma = makePrisma({
    course: { findFirst: async ({ where }) => { courseWhere = where; return null; } },
    attendanceSession: { create: async () => { sessionCreate = true; return {}; } },
  });
  const baseUrl = await startServer(prisma, "FACULTY");
  const { response } = await request(baseUrl, "POST", "/api/attendance/sessions", {
    body: { courseId: "course-b", title: "Week one", startsAt: "2026-10-01T10:00:00Z" },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(courseWhere, { id: "course-b", organizationId: "org-a", facultyId: "user-a" });
  assert.equal(sessionCreate, false);
});

test("attendance recording updates the existing session and enrollment record and report totals", async () => {
  const session = { id: "session-a", organizationId: "org-a", courseId: "course-a" };
  const records = [];
  let upsertWhere;
  const prisma = makePrisma({
    attendanceSession: { findFirst: async ({ where }) => where.id === session.id && where.organizationId === session.organizationId ? session : null },
    enrollment: { findFirst: async ({ where }) => {
      assert.deepEqual(where, { courseId: "course-a", studentId: "student-a", organizationId: "org-a" });
      return { id: "enrollment-a" };
    } },
    course: { findFirst: async ({ where }) => where.id === "course-a" && where.organizationId === "org-a" ? { id: "course-a", code: "BIO-101", title: "Biology" } : null },
    attendanceRecord: {
      findFirst: async ({ where }) => records[0] && where.sessionId === records[0].sessionId && where.enrollmentId === records[0].enrollmentId && where.organizationId === records[0].organizationId ? { id: records[0].id } : null,
      upsert: async ({ where, create, update }) => {
        upsertWhere = where;
        if (records.length) Object.assign(records[0], update, { updatedAt: new Date() });
        else records.push({ id: "attendance-a", ...create, markedAt: new Date(), updatedAt: new Date() });
        return { ...records[0] };
      },
      groupBy: async ({ where }) => {
        assert.deepEqual(where, { courseId: "course-a", organizationId: "org-a" });
        return records.length ? [{ status: records[0].status, _count: { _all: records.length } }] : [];
      },
    },
  });
  const baseUrl = await startServer(prisma, "ADMIN");

  const missingStatus = await request(baseUrl, "POST", "/api/attendance/sessions/session-a/records", { body: { studentId: "student-a" } });
  assert.equal(missingStatus.response.status, 400);
  assert.equal(records.length, 0);
  assert.equal(upsertWhere, undefined);

  const first = await request(baseUrl, "POST", "/api/attendance/sessions/session-a/records", { body: { studentId: "student-a", status: "PRESENT" } });
  assert.equal(first.response.status, 201);
  assert.equal(first.json.data.status, "PRESENT");
  assert.equal(first.json.created, true);
  assert.equal(records[0].id, "attendance-a");

  for (const status of ["LATE", "ABSENT", "EXCUSED"]) {
    const updated = await request(baseUrl, "POST", "/api/attendance/sessions/session-a/records", { body: { studentId: "student-a", status } });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.json.created, false);
    assert.equal(updated.json.data.id, "attendance-a");
    assert.equal(updated.json.data.status, status);
    assert.equal(records[0].id, "attendance-a");
    assert.equal(records.length, 1);
    assert.deepEqual(upsertWhere, { sessionId_enrollmentId: { sessionId: "session-a", enrollmentId: "enrollment-a" } });

    const report = await request(baseUrl, "GET", "/api/attendance/reports/course/course-a");
    assert.equal(report.response.status, 200);
    assert.equal(report.json.data.total, 1);
    assert.equal(report.json.data.totals.PRESENT, 0);
    assert.equal(report.json.data.totals[status], 1);
  }
});

test("student attendance queries are scoped to the authenticated student and tenant", async () => {
  let findArgs;
  let countArgs;
  const prisma = makePrisma({ attendanceRecord: {
    findMany: async (args) => { findArgs = args; return []; },
    count: async (args) => { countArgs = args; return 0; },
  } });
  const baseUrl = await startServer(prisma, "STUDENT");
  const { response } = await request(baseUrl, "GET", "/api/attendance/me?organizationId=org-b&studentId=user-b");
  assert.equal(response.status, 200);
  const expected = { organizationId: "org-a", enrollment: { is: { studentId: "user-a", organizationId: "org-a" } } };
  assert.deepEqual(findArgs.where, expected);
  assert.deepEqual(countArgs, { where: expected });
});

test("notifications can only be marked read by their intended recipient", async () => {
  let updateWhere;
  let findWhere;
  const prisma = makePrisma({ notification: {
    updateMany: async ({ where }) => { updateWhere = where; return { count: 0 }; },
    findFirst: async ({ where }) => { findWhere = where; return null; },
  } });
  const baseUrl = await startServer(prisma);
  const { response } = await request(baseUrl, "PATCH", "/api/notifications/notification-b/read");
  assert.equal(response.status, 404);
  assert.deepEqual(updateWhere, { id: "notification-b", organizationId: "org-a", recipientId: "user-a", readAt: null });
  assert.deepEqual(findWhere, { id: "notification-b", organizationId: "org-a", recipientId: "user-a" });
});

test("notification read filters distinguish unread from read records", async () => {
  const filters = [];
  const prisma = makePrisma({ notification: {
    findMany: async ({ where }) => { filters.push(where); return []; },
    count: async ({ where }) => { filters.push(where); return 0; },
  } });
  const baseUrl = await startServer(prisma, "STUDENT");
  const unread = await request(baseUrl, "GET", "/api/notifications?unread=true");
  const read = await request(baseUrl, "GET", "/api/notifications?unread=false");
  assert.equal(unread.response.status, 200);
  assert.equal(read.response.status, 200);
  assert.ok(filters.some((where) => where.readAt === null));
  assert.ok(filters.some((where) => JSON.stringify(where.readAt) === JSON.stringify({ not: null })));
  assert.ok(filters.every((where) => where.organizationId === "org-a" && where.recipientId === "user-a"));
});

test("document listing omits storage references and upload metadata is unavailable without storage", async () => {
  const project = { id: "project-a", organizationId: "org-a", ownerId: "user-a", status: "ACTIVE", startsAt: null, dueAt: null };
  let documentArgs;
  let createCalled = false;
  const prisma = makePrisma({
    project: { findFirst: async () => project },
    projectDocument: {
      findMany: async (args) => { documentArgs = args; return []; },
      count: async () => 0,
      create: async () => { createCalled = true; return {}; },
    },
  });
  const baseUrl = await startServer(prisma);
  const listed = await request(baseUrl, "GET", "/api/projects/project-a/documents");
  assert.equal(listed.response.status, 200);
  assert.equal(documentArgs.select.storageKey, undefined);
  assert.equal(documentArgs.where.organizationId, "org-a");
  const upload = await request(baseUrl, "POST", "/api/projects/documents", { body: {
    projectId: "project-a", originalName: "plan.pdf", contentType: "application/pdf", sizeBytes: 100, storageKey: "opaque-storage-ref-1234",
  } });
  assert.equal(upload.response.status, 503);
  assert.equal(createCalled, false);
});

test("document metadata requires project access and only returns safe fields", async () => {
  const project = { id: "project-a", organizationId: "org-a", ownerId: "user-a", status: "ACTIVE", startsAt: null, dueAt: null };
  let createArgs;
  let verified;
  const prisma = makePrisma({
    project: { findFirst: async ({ where }) => where.id === project.id && where.organizationId === project.organizationId ? project : null },
    projectDocument: { create: async (args) => {
      createArgs = args;
      return {
        id: "document-a", projectId: args.data.projectId, taskId: args.data.taskId,
        uploaderId: args.data.uploaderId, originalName: args.data.originalName,
        contentType: args.data.contentType, sizeBytes: args.data.sizeBytes, createdAt: new Date(),
      };
    } },
  });
  const baseUrl = await startServer(prisma, "ADMIN", "user-a", "org-a", {
    documentStorage: { verifyObject: async (requestData) => { verified = requestData; return true; } },
  });
  const { response, json } = await request(baseUrl, "POST", "/api/projects/documents", { body: {
    projectId: "project-a", originalName: "notes.pdf", contentType: "application/pdf", sizeBytes: 500, storageKey: "opaque-storage-reference-123",
  } });
  assert.equal(response.status, 201);
  assert.equal(verified.organizationId, "org-a");
  assert.equal(verified.projectId, "project-a");
  assert.equal(createArgs.data.organizationId, "org-a");
  assert.equal(createArgs.data.uploaderId, "user-a");
  assert.equal(createArgs.select.storageKey, undefined);
  assert.equal("storageKey" in json.data, false);
});

test("student dashboard aggregates use authenticated tenant and student filters", async () => {
  const queries = [];
  const collect = { count: async ({ where }) => { queries.push(where); return 0; }, groupBy: async ({ where }) => { queries.push(where); return []; } };
  const prisma = makePrisma({
    notification: { count: async ({ where }) => { queries.push(where); return 0; } },
    enrollment: { count: collect.count }, attendanceRecord: { count: collect.count },
    projectMember: { count: collect.count }, project: { groupBy: collect.groupBy }, task: { count: collect.count, groupBy: collect.groupBy },
  });
  const baseUrl = await startServer(prisma, "STUDENT");
  const { response, json } = await request(baseUrl, "GET", "/api/dashboard?organizationId=org-b");
  assert.equal(response.status, 200);
  assert.equal(json.success, true);
  assert.ok(queries.length >= 7);
  assert.ok(queries.every((where) => where.organizationId === "org-a"));
  assert.ok(queries.some((where) => where.studentId === "user-a"));
  assert.ok(queries.some((where) => where.assigneeId === "user-a"));
});
