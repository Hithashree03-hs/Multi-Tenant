const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");

const JWT_SECRET = "users-tests-use-a-local-only-jwt-secret";
const servers = new Set();

function matches(record, where) {
  return Object.entries(where || {}).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) return value.in.includes(record[key]);
    return record[key] === value;
  });
}

function makePrisma({ role = "ADMIN", users = [], overrides = {} } = {}) {
  const records = [
    { id: "user-a", name: "Tenant Admin", email: "admin@a.invalid", password: "hash", role, organizationId: "org-a" },
    ...users,
  ];
  const prisma = {
    organization: { findMany: async () => [], findUnique: async () => null },
    department: { findMany: async () => [], findFirst: async () => null, count: async () => 0 },
    course: { count: async () => 0 },
    user: {
      findFirst: async ({ where }) => records.find((record) => matches(record, where)) || null,
      findMany: async ({ where }) => records.filter((record) => matches(record, where)),
      count: async ({ where }) => records.filter((record) => matches(record, where)).length,
      create: async ({ data }) => {
        const record = { id: `user-${records.length}`, ...data, createdAt: new Date(), updatedAt: new Date() };
        records.push(record);
        return record;
      },
      updateMany: async ({ where, data }) => {
        const record = records.find((item) => matches(item, where));
        if (!record) return { count: 0 };
        Object.assign(record, data);
        return { count: 1 };
      },
      ...overrides,
    },
  };
  return { prisma, records };
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

async function request(baseUrl, method, path, { role = "ADMIN", body, token } = {}) {
  const bearer = token || jwt.sign(
    { role, organizationId: "org-a" },
    JWT_SECRET,
    { subject: "user-a", expiresIn: "1h", algorithm: "HS256" },
  );
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

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
});

test("administrator creates a tenant student with a bcrypt hash and safe response", async () => {
  let createdData;
  const { prisma } = makePrisma({ overrides: {
    create: async ({ data }) => {
      createdData = data;
      return { id: "student-new", ...data, createdAt: new Date(), updatedAt: new Date() };
    },
  } });
  const baseUrl = await startServer(prisma);
  const { response, json } = await request(baseUrl, "POST", "/api/users", {
    body: { name: " New Student ", email: " Student@Example.edu ", password: "local-test-password" },
  });

  assert.equal(response.status, 201);
  assert.equal(createdData.name, "New Student");
  assert.equal(createdData.email, "student@example.edu");
  assert.equal(createdData.role, "STUDENT");
  assert.equal(createdData.organizationId, "org-a");
  assert.notEqual(createdData.password, "local-test-password");
  assert.equal(await bcrypt.compare("local-test-password", createdData.password), true);
  assert.equal("password" in json.data, false);
  assert.equal(JSON.stringify(json).includes(createdData.password), false);
});

test("faculty can read the student directory but cannot create or update accounts", async () => {
  let createCalled = false;
  let updateCalled = false;
  const { prisma } = makePrisma({ overrides: {
    create: async () => { createCalled = true; return {}; },
    updateMany: async () => { updateCalled = true; return { count: 1 }; },
  } });
  const baseUrl = await startServer(prisma, "FACULTY");
  const created = await request(baseUrl, "POST", "/api/users", {
    role: "FACULTY",
    body: { name: "New Student", email: "new@a.invalid", password: "local-test-password" },
  });
  const updated = await request(baseUrl, "PATCH", "/api/users/student-a", {
    role: "FACULTY", body: { name: "Changed" },
  });
  assert.equal(created.response.status, 403);
  assert.equal(updated.response.status, 403);
  assert.equal(createCalled, false);
  assert.equal(updateCalled, false);
});

test("students cannot read or manage other user accounts", async () => {
  let queries = 0;
  let createCalled = false;
  const { prisma } = makePrisma({ role: "STUDENT", overrides: {
    findMany: async () => { queries += 1; return []; },
    create: async () => { createCalled = true; return {}; },
  } });
  const baseUrl = await startServer(prisma, "STUDENT");
  const listed = await request(baseUrl, "GET", "/api/users", { role: "STUDENT" });
  const detail = await request(baseUrl, "GET", "/api/users/user-a", { role: "STUDENT" });
  const created = await request(baseUrl, "POST", "/api/users", {
    role: "STUDENT", body: { name: "New Student", email: "new@a.invalid", password: "local-test-password" },
  });
  const updated = await request(baseUrl, "PATCH", "/api/users/user-a", { role: "STUDENT", body: { name: "Changed" } });
  assert.equal(listed.response.status, 403);
  assert.equal(detail.response.status, 403);
  assert.equal(created.response.status, 403);
  assert.equal(updated.response.status, 403);
  assert.equal(queries, 0);
  assert.equal(createCalled, false);
});

test("clients cannot choose an organization or grant the ADMIN role", async () => {
  let createCalled = false;
  const { prisma } = makePrisma({ overrides: { create: async () => { createCalled = true; return {}; } } });
  const baseUrl = await startServer(prisma);
  const adminAttempt = await request(baseUrl, "POST", "/api/users", {
    body: { name: "Admin", email: "new-admin@a.invalid", password: "local-test-password", role: "ADMIN" },
  });
  assert.equal(adminAttempt.response.status, 400);
  const tenantAttempt = await request(baseUrl, "POST", "/api/users", {
    body: { name: "Student", email: "new-student@a.invalid", password: "local-test-password", organizationId: "org-b" },
  });
  assert.equal(tenantAttempt.response.status, 400);
  assert.equal(createCalled, false);
});

test("duplicate managed-user email returns HTTP 409 without database details", async () => {
  const { prisma } = makePrisma({ overrides: {
    create: async () => { const error = new Error("unique constraint details"); error.code = "P2002"; throw error; },
  } });
  const baseUrl = await startServer(prisma);
  const { response, json } = await request(baseUrl, "POST", "/api/users", {
    body: { name: "Student", email: "duplicate@a.invalid", password: "local-test-password" },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(json, { success: false, message: "An account with this email already exists" });
});

test("faculty directory queries are limited to students in the authenticated tenant", async () => {
  let listArgs;
  const { prisma } = makePrisma({ overrides: {
    findMany: async (args) => {
      listArgs = args;
      return [{ id: "student-a", name: "Student A", email: "student@a.invalid", role: "STUDENT", organizationId: "org-a" }];
    },
    count: async () => 1,
  } });
  const baseUrl = await startServer(prisma, "FACULTY");
  const { response, json } = await request(baseUrl, "GET", "/api/users?organizationId=org-b", { role: "FACULTY" });

  assert.equal(response.status, 200);
  assert.deepEqual(listArgs.where, { organizationId: "org-a", role: "STUDENT" });
  assert.equal("password" in json.data[0], false);
});

test("administrator cannot update a user from another organization", async () => {
  let updateCalled = false;
  const { prisma } = makePrisma({ overrides: {
    findFirst: async ({ where }) => where.id === "other-student" ? null : { id: "user-a", role: "ADMIN" },
    updateMany: async () => { updateCalled = true; return { count: 1 }; },
  } });
  const baseUrl = await startServer(prisma);
  const { response } = await request(baseUrl, "PATCH", "/api/users/other-student", { body: { name: "Changed" } });
  assert.equal(response.status, 404);
  assert.equal(updateCalled, false);
});

test("administrator can update a non-admin account in the authenticated organization", async () => {
  const { prisma, records } = makePrisma({ users: [
    { id: "student-a", name: "Student A", email: "student@a.invalid", password: "hash", role: "STUDENT", organizationId: "org-a" },
  ] });
  const baseUrl = await startServer(prisma);
  const { response, json } = await request(baseUrl, "PATCH", "/api/users/student-a", { body: { name: " Updated Student " } });
  assert.equal(response.status, 200);
  assert.equal(records.find(({ id }) => id === "student-a").name, "Updated Student");
  assert.equal(json.data.role, "STUDENT");
});

test("administrator cannot assign the ADMIN role to managed accounts", async () => {
  let updateCalled = false;
  const { prisma } = makePrisma({ overrides: {
    updateMany: async () => { updateCalled = true; return { count: 1 }; },
  } });
  const baseUrl = await startServer(prisma);
  const { response } = await request(baseUrl, "PATCH", "/api/users/student-a", { body: { role: "ADMIN" } });
  assert.equal(response.status, 400);
  assert.equal(updateCalled, false);
});

test("administrator must reassign a faculty member's courses before demoting them", async () => {
  let updateCalled = false;
  const { prisma } = makePrisma({ overrides: {
    findFirst: async ({ where }) => where.id === "faculty-a"
      ? { id: "faculty-a", role: "FACULTY", organizationId: "org-a" }
      : { id: "user-a", role: "ADMIN", organizationId: "org-a" },
    updateMany: async () => { updateCalled = true; return { count: 1 }; },
  } });
  prisma.course.count = async () => 2;
  const baseUrl = await startServer(prisma);
  const { response, json } = await request(baseUrl, "PATCH", "/api/users/faculty-a", { body: { role: "STUDENT" } });
  assert.equal(response.status, 409);
  assert.match(json.message, /Reassign/);
  assert.equal(updateCalled, false);
});
