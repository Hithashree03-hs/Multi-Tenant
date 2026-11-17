const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");

const JWT_SECRET = "department-tests-use-a-local-only-jwt-secret";
const servers = new Set();

function makePrisma({ role = "ADMIN", organizationId = "org-a", userId = "user-a", ...overrides } = {}) {
  return {
    organization: {
      findMany: async () => [], findUnique: async () => null, findFirst: async () => null,
      create: async () => ({}), updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }),
      ...(overrides.organization || {}),
    },
    user: {
      findFirst: async ({ where }) => where.id === userId && where.organizationId === organizationId
        ? { id: userId, organizationId, role }
        : null,
      ...(overrides.user || {}),
    },
    department: {
      findMany: async () => [], findFirst: async () => null, count: async () => 0,
      create: async () => ({}), updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }),
      ...(overrides.department || {}),
    },
  };
}

async function startServer(prisma) {
  const app = createApp(prisma, {
    jwtSecret: JWT_SECRET,
    platformAdminSecret: "department-tests-platform-key-is-not-real",
  });
  const server = app.listen(0);
  servers.add(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(baseUrl, method, path, { role = "STUDENT", organizationId = "org-a", body } = {}) {
  const token = jwt.sign(
    { role, organizationId },
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

test("department creation derives organization from the database-backed user", async () => {
  let createArgs;
  const prisma = makePrisma({
    role: "ADMIN",
    department: {
      create: async (args) => {
        createArgs = args;
        return { id: "department-1", createdAt: new Date("2026-01-01T00:00:00Z"), ...args.data };
      },
    },
  });
  const baseUrl = await startServer(prisma);
  const { response, json } = await request(baseUrl, "POST", "/api/departments", {
    role: "STUDENT",
    organizationId: "org-a",
    body: { name: "Computer Science", code: " cs " },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(createArgs.data, { name: "Computer Science", code: "CS", organizationId: "org-a" });
  assert.equal(json.data.organizationId, "org-a");
});

test("current database role overrides a stale role claim before authorization", async () => {
  let createCalled = false;
  const baseUrl = await startServer(makePrisma({
    role: "STUDENT",
    department: { create: async () => { createCalled = true; return {}; } },
  }));
  const { response, json } = await request(baseUrl, "POST", "/api/departments", {
    role: "ADMIN",
    body: { name: "Computer Science", code: "CS" },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(json, { success: false, message: "Forbidden" });
  assert.equal(createCalled, false);
});

test("department listing uses pagination and the authenticated tenant only", async () => {
  let findArgs;
  let countArgs;
  const baseUrl = await startServer(makePrisma({
    department: {
      findMany: async (args) => {
        findArgs = args;
        return [{ id: "department-a", organizationId: "org-a" }];
      },
      count: async (args) => {
        countArgs = args;
        return 21;
      },
    },
  }));
  const { response, json } = await request(baseUrl, "GET", "/api/departments?organizationId=org-b&page=2&limit=10");

  assert.equal(response.status, 200);
  assert.deepEqual(findArgs.where, { organizationId: "org-a" });
  assert.equal(findArgs.skip, 10);
  assert.equal(findArgs.take, 10);
  assert.deepEqual(countArgs.where, { organizationId: "org-a" });
  assert.deepEqual(json.pagination, { page: 2, limit: 10, total: 21, totalPages: 3 });
});

test("department detail query is tenant-scoped and hides another tenant's department", async () => {
  let query;
  const baseUrl = await startServer(makePrisma({
    department: {
      findFirst: async (args) => {
        query = args;
        return null;
      },
    },
  }));
  const { response, json } = await request(baseUrl, "GET", "/api/departments/department-b");

  assert.equal(response.status, 404);
  assert.deepEqual(query.where, { id: "department-b", organizationId: "org-a" });
  assert.deepEqual(json, { success: false, message: "Department not found" });
});

test("department creation rejects a client-supplied organization ID", async () => {
  let createCalled = false;
  const baseUrl = await startServer(makePrisma({
    department: { create: async () => { createCalled = true; return {}; } },
  }));
  const { response, json } = await request(baseUrl, "POST", "/api/departments", {
    role: "STUDENT",
    body: { name: "Computer Science", code: "CS", organizationId: "org-b" },
  });

  assert.equal(response.status, 400);
  assert.match(json.message, /organization is assigned/);
  assert.equal(createCalled, false);
});

test("faculty and students cannot create, edit, or delete departments", async () => {
  for (const role of ["FACULTY", "STUDENT"]) {
    let writes = 0;
    const baseUrl = await startServer(makePrisma({ role, department: {
      create: async () => { writes += 1; return {}; },
      updateMany: async () => { writes += 1; return { count: 1 }; },
      deleteMany: async () => { writes += 1; return { count: 1 }; },
    } }));
    const created = await request(baseUrl, "POST", "/api/departments", { role, body: { name: "Science", code: "SCI" } });
    const updated = await request(baseUrl, "PATCH", "/api/departments/department-a", { role, body: { name: "Changed" } });
    const deleted = await request(baseUrl, "DELETE", "/api/departments/department-a", { role });
    assert.deepEqual([created.response.status, updated.response.status, deleted.response.status], [403, 403, 403]);
    assert.equal(writes, 0);
  }
});

test("department code conflicts return HTTP 409", async () => {
  const conflict = Object.assign(new Error("private detail"), { code: "P2002" });
  const baseUrl = await startServer(makePrisma({
    role: "ADMIN",
    department: { create: async () => { throw conflict; } },
  }));
  const { response, json } = await request(baseUrl, "POST", "/api/departments", {
    role: "STUDENT",
    body: { name: "Computer Science", code: "CS" },
  });
  assert.equal(response.status, 409);
  assert.equal(json.success, false);
  assert.doesNotMatch(JSON.stringify(json), /private detail/);
});

test("department update and deletion scope mutations to the user's organization", async () => {
  let updateArgs;
  let deleteArgs;
  const baseUrl = await startServer(makePrisma({
    role: "ADMIN",
    department: {
      updateMany: async (args) => {
        updateArgs = args;
        return { count: 1 };
      },
      findFirst: async ({ where }) => ({ id: where.id, name: "Updated", code: "CS", organizationId: where.organizationId }),
      deleteMany: async (args) => {
        deleteArgs = args;
        return { count: 1 };
      },
    },
  }));
  const updated = await request(baseUrl, "PATCH", "/api/departments/department-a", {
    role: "STUDENT", body: { name: " Updated " },
  });
  const deleted = await request(baseUrl, "DELETE", "/api/departments/department-a", { role: "STUDENT" });

  assert.equal(updated.response.status, 200);
  assert.deepEqual(updateArgs.where, { id: "department-a", organizationId: "org-a" });
  assert.deepEqual(updateArgs.data, { name: "Updated" });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleteArgs.where, { id: "department-a", organizationId: "org-a" });
});

test("department listing validates page and limit query parameters", async () => {
  const baseUrl = await startServer(makePrisma());
  const invalidPage = await request(baseUrl, "GET", "/api/departments?page=zero");
  const invalidLimit = await request(baseUrl, "GET", "/api/departments?limit=1000");
  assert.equal(invalidPage.response.status, 400);
  assert.equal(invalidLimit.response.status, 400);
});
