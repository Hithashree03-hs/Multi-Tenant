const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");

const JWT_SECRET = "organization-tests-use-a-local-only-jwt-secret";
const PLATFORM_SECRET = "organization-tests-use-a-local-platform-secret";
const servers = new Set();

async function startServer(prisma, options = {}) {
  const app = createApp(prisma, {
    jwtSecret: JWT_SECRET,
    platformAdminSecret: PLATFORM_SECRET,
    ...options,
  });
  const server = app.listen(0);
  servers.add(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(baseUrl, method, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, json: await response.json() };
}

function makePrisma(overrides = {}) {
  return {
    organization: {
      findMany: async () => [],
      findUnique: async () => null,
      findFirst: async () => null,
      create: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
      ...overrides.organization,
    },
    user: {
      findFirst: async () => null,
      ...overrides.user,
    },
  };
}

const platformHeaders = () => ({ "x-platform-admin-key": PLATFORM_SECRET });
function userToken(role, organizationId = "org-a", userId = "user-a") {
  return jwt.sign({ role, organizationId }, JWT_SECRET, { subject: userId, expiresIn: "1h", algorithm: "HS256" });
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
});

test("platform administrator creates an organization after trimming fields", async () => {
  const organization = { id: "org-1", name: "Global Academy", slug: "global-academy" };
  let receivedData;
  const baseUrl = await startServer(makePrisma({
    organization: {
      create: async ({ data }) => {
        receivedData = data;
        return organization;
      },
    },
  }));
  const { response, json } = await request(baseUrl, "POST", "/api/organizations", {
    name: " Global Academy ", slug: " global-academy ",
  }, platformHeaders());

  assert.equal(response.status, 201);
  assert.deepEqual(receivedData, { name: "Global Academy", slug: "global-academy" });
  assert.deepEqual(json, { success: true, data: organization });
});

test("organization creation requires the platform credential", async () => {
  const baseUrl = await startServer(makePrisma({
    organization: { create: async () => assert.fail("database must not be called") },
  }));
  const { response, json } = await request(baseUrl, "POST", "/api/organizations", {
    name: "College", slug: "college",
  });
  assert.equal(response.status, 403);
  assert.deepEqual(json, { success: false, message: "Platform administrator access required" });
});

test("a tenant ADMIN bearer token does not authorize organization creation", async () => {
  let createCalled = false;
  const baseUrl = await startServer(makePrisma({
    organization: { create: async () => { createCalled = true; return {}; } },
  }));
  const { response, json } = await request(baseUrl, "POST", "/api/organizations", {
    name: "Tenant Academy", slug: "tenant-academy",
  }, { Authorization: `Bearer ${userToken("ADMIN")}` });

  assert.equal(response.status, 403);
  assert.deepEqual(json, { success: false, message: "Platform administrator access required" });
  assert.equal(createCalled, false);
});

test("organization creation fails closed when platform administration is not configured", async () => {
  const baseUrl = await startServer(makePrisma(), { platformAdminSecret: "" });
  const { response, json } = await request(baseUrl, "POST", "/api/organizations", {
    name: "College", slug: "college",
  }, platformHeaders());
  assert.equal(response.status, 503);
  assert.deepEqual(json, { success: false, message: "Platform administration is not configured" });
});

test("rejects missing and non-string organization fields", async () => {
  const baseUrl = await startServer(makePrisma({
    organization: { create: async () => assert.fail("database must not be called") },
  }));
  const missing = await request(baseUrl, "POST", "/api/organizations", { name: "Only name" }, platformHeaders());
  const invalid = await request(baseUrl, "POST", "/api/organizations", { name: 12, slug: [] }, platformHeaders());
  assert.equal(missing.response.status, 400);
  assert.equal(missing.json.success, false);
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.json.message, "Name and slug must be strings");
});

test("rejects empty and overlong organization values", async () => {
  const baseUrl = await startServer(makePrisma());
  const empty = await request(baseUrl, "POST", "/api/organizations", {
    name: "  ", slug: "valid",
  }, platformHeaders());
  const longName = await request(baseUrl, "POST", "/api/organizations", {
    name: "n".repeat(121), slug: "valid",
  }, platformHeaders());
  const longSlug = await request(baseUrl, "POST", "/api/organizations", {
    name: "College", slug: `a${"b".repeat(63)}`,
  }, platformHeaders());
  assert.equal(empty.response.status, 400);
  assert.equal(longName.response.status, 400);
  assert.equal(longSlug.response.status, 400);
});

test("rejects malformed slugs and client-supplied authorization fields", async () => {
  const baseUrl = await startServer(makePrisma());
  const malformed = await request(baseUrl, "POST", "/api/organizations", {
    name: "College", slug: "Invalid Slug",
  }, platformHeaders());
  const overposted = await request(baseUrl, "POST", "/api/organizations", {
    name: "College", slug: "college", organizationId: "attacker-org",
  }, platformHeaders());
  assert.equal(malformed.response.status, 400);
  assert.match(malformed.json.message, /Slug must/);
  assert.equal(overposted.response.status, 400);
  assert.equal(overposted.json.message, "Only name and slug are allowed");
});

test("maps duplicate organization slugs to HTTP 409 without leaking database details", async () => {
  const error = Object.assign(new Error("private database detail"), { code: "P2002" });
  const baseUrl = await startServer(makePrisma({
    organization: { create: async () => { throw error; } },
  }));
  const { response, json } = await request(baseUrl, "POST", "/api/organizations", {
    name: "College", slug: "college",
  }, platformHeaders());
  assert.equal(response.status, 409);
  assert.deepEqual(json, { success: false, message: "An organization with this slug already exists" });
  assert.doesNotMatch(JSON.stringify(json), /private database detail/);
});

test("ordinary authenticated users only see their own organization", async () => {
  let selectedWhere;
  let globalListCalled = false;
  const baseUrl = await startServer(makePrisma({
    organization: {
      findUnique: async ({ where }) => {
        selectedWhere = where;
        return { id: "org-a", name: "Academy A", slug: "academy-a" };
      },
      findMany: async () => {
        globalListCalled = true;
        return [{ id: "org-a" }, { id: "org-b" }];
      },
    },
    user: {
      findFirst: async ({ where }) => ({ id: where.id, role: "STUDENT", organizationId: "org-a" }),
    },
  }));
  const token = jwt.sign(
    { role: "ADMIN", organizationId: "org-a" },
    JWT_SECRET,
    { subject: "user-a", expiresIn: "1h", algorithm: "HS256" },
  );
  const { response, json } = await request(baseUrl, "GET", "/api/organizations?organizationId=org-b", undefined, {
    Authorization: `Bearer ${token}`,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(selectedWhere, { id: "org-a" });
  assert.equal(globalListCalled, false);
  assert.deepEqual(json.data.map((organization) => organization.id), ["org-a"]);
});

test("ordinary users cannot retrieve another organization's details", async () => {
  let organizationLookupCalled = false;
  const baseUrl = await startServer(makePrisma({
    organization: {
      findUnique: async () => {
        organizationLookupCalled = true;
        return { id: "org-b" };
      },
    },
    user: { findFirst: async ({ where }) => ({ id: where.id, role: "STUDENT", organizationId: "org-a" }) },
  }));
  const token = jwt.sign(
    { role: "STUDENT", organizationId: "org-a" },
    JWT_SECRET,
    { subject: "user-a", expiresIn: "1h", algorithm: "HS256" },
  );
  const { response, json } = await request(baseUrl, "GET", "/api/organizations/org-b", undefined, {
    Authorization: `Bearer ${token}`,
  });

  assert.equal(response.status, 404);
  assert.equal(organizationLookupCalled, false);
  assert.deepEqual(json, { success: false, message: "Organization not found" });
});

test("tenant administrators can update only their own organization settings", async () => {
  const updates = [];
  const baseUrl = await startServer(makePrisma({
    organization: {
      updateMany: async (args) => { updates.push(args); return { count: 1 }; },
      findUnique: async ({ where }) => ({ id: where.id, name: "Updated Academy", slug: "updated-academy" }),
    },
    user: { findFirst: async ({ where }) => ({ id: where.id, organizationId: where.organizationId, role: "ADMIN" }) },
  }));
  const headers = { Authorization: `Bearer ${userToken("ADMIN")}` };
  const own = await request(baseUrl, "PATCH", "/api/organizations/org-a", { name: " Updated Academy ", slug: " updated-academy " }, headers);
  const foreign = await request(baseUrl, "PATCH", "/api/organizations/org-b", { name: "Other Academy" }, headers);

  assert.equal(own.response.status, 200);
  assert.deepEqual(updates, [{ where: { id: "org-a" }, data: { name: "Updated Academy", slug: "updated-academy" } }]);
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.json.message, "Organization not found");
});

test("partial organization edits preserve omitted fields and target only the requested organization ID", async () => {
  const organization = { id: "org-a", name: "Original Academy", slug: "original-academy" };
  const updates = [];
  const baseUrl = await startServer(makePrisma({
    organization: {
      updateMany: async ({ where, data }) => {
        updates.push({ where, data });
        if (where.id !== organization.id) return { count: 0 };
        Object.assign(organization, data);
        return { count: 1 };
      },
      findUnique: async ({ where }) => where.id === organization.id ? { ...organization } : null,
    },
    user: { findFirst: async ({ where }) => ({ id: where.id, organizationId: where.organizationId, role: "ADMIN" }) },
  }));
  const headers = { Authorization: `Bearer ${userToken("ADMIN")}` };

  const nameUpdate = await request(baseUrl, "PATCH", "/api/organizations/org-a", { name: "Renamed Academy" }, headers);
  assert.equal(nameUpdate.response.status, 200);
  assert.deepEqual(nameUpdate.json.data, { ...organization });
  assert.equal(nameUpdate.json.data.slug, "original-academy");

  const slugUpdate = await request(baseUrl, "PATCH", "/api/organizations/org-a", { slug: "renamed-campus" }, headers);
  assert.equal(slugUpdate.response.status, 200);
  assert.equal(slugUpdate.json.data.name, "Renamed Academy");
  assert.equal(slugUpdate.json.data.slug, "renamed-campus");

  const fetched = await request(baseUrl, "GET", "/api/organizations/org-a", undefined, headers);
  assert.equal(fetched.response.status, 200);
  assert.deepEqual(fetched.json.data, organization);
  assert.deepEqual(updates, [
    { where: { id: "org-a" }, data: { name: "Renamed Academy" } },
    { where: { id: "org-a" }, data: { slug: "renamed-campus" } },
  ]);
});

test("organization PATCH rejects invalid or empty edits without changing stored values", async () => {
  const organization = { id: "org-a", name: "Original Academy", slug: "original-academy" };
  let updateCalled = false;
  const baseUrl = await startServer(makePrisma({
    organization: {
      updateMany: async () => { updateCalled = true; return { count: 1 }; },
    },
    user: { findFirst: async ({ where }) => ({ id: where.id, organizationId: where.organizationId, role: "ADMIN" }) },
  }));
  const headers = { Authorization: `Bearer ${userToken("ADMIN")}` };
  const empty = await request(baseUrl, "PATCH", "/api/organizations/org-a", {}, headers);
  const invalid = await request(baseUrl, "PATCH", "/api/organizations/org-a", { name: "   " }, headers);
  const overposted = await request(baseUrl, "PATCH", "/api/organizations/org-a", { slug: "other", organizationId: "org-b" }, headers);

  assert.equal(empty.response.status, 400);
  assert.equal(invalid.response.status, 400);
  assert.equal(overposted.response.status, 400);
  assert.equal(updateCalled, false);
  assert.deepEqual(organization, { id: "org-a", name: "Original Academy", slug: "original-academy" });
});

test("faculty and students cannot update organization settings", async () => {
  for (const role of ["FACULTY", "STUDENT"]) {
    let updateCalled = false;
    const baseUrl = await startServer(makePrisma({
      organization: { updateMany: async () => { updateCalled = true; return { count: 1 }; } },
      user: { findFirst: async ({ where }) => ({ id: where.id, organizationId: where.organizationId, role }) },
    }));
    const { response } = await request(baseUrl, "PATCH", "/api/organizations/org-a", { name: "Not allowed" }, {
      Authorization: `Bearer ${userToken(role)}`,
    });
    assert.equal(response.status, 403);
    assert.equal(updateCalled, false);
  }
});

test("platform credential can list organizations globally", async () => {
  const allOrganizations = [{ id: "org-a" }, { id: "org-b" }];
  const baseUrl = await startServer(makePrisma({
    organization: { findMany: async () => allOrganizations },
  }));
  const { response, json } = await request(baseUrl, "GET", "/api/organizations", undefined, platformHeaders());
  assert.equal(response.status, 200);
  assert.deepEqual(json.data, allOrganizations);
});

test("platform credential updates and deletes organizations", async () => {
  let updateArgs;
  let deleteArgs;
  const baseUrl = await startServer(makePrisma({
    organization: {
      updateMany: async (args) => {
        updateArgs = args;
        return { count: 1 };
      },
      findUnique: async ({ where }) => ({ id: where.id, name: "Updated", slug: "updated" }),
      deleteMany: async (args) => {
        deleteArgs = args;
        return { count: 1 };
      },
    },
  }));
  const updated = await request(baseUrl, "PATCH", "/api/organizations/org-1", { name: " Updated " }, platformHeaders());
  const deleted = await request(baseUrl, "DELETE", "/api/organizations/org-1", undefined, platformHeaders());
  assert.equal(updated.response.status, 200);
  assert.deepEqual(updateArgs, { where: { id: "org-1" }, data: { name: "Updated" } });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleteArgs, { where: { id: "org-1" } });
  assert.deepEqual(deleted.json, { success: true, message: "Organization deleted" });
});
