const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");
const createAuthMiddleware = require("../src/middleware/authenticate");
const requireRole = require("../src/middleware/authorizeRoles");

const TEST_SECRET = "test-only-secret-for-campusflow-auth";
const TEST_PASSWORD = "correct-horse-battery";
const servers = new Set();

async function startServer(app) {
  const server = app.listen(0);
  servers.add(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(baseUrl, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() };
}

async function get(baseUrl, path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { response, json: await response.json() };
}

function makePrisma(overrides = {}) {
  return {
    organization: {
      findUnique: async () => ({ id: "org-approved" }),
      findMany: async () => [],
      create: async () => ({}),
      ...overrides.organization,
    },
    user: {
      findFirst: async () => null,
      findUnique: async () => null,
      create: async ({ data }) => ({ id: "user-1", createdAt: new Date("2026-01-01T00:00:00Z"), ...data }),
      ...overrides.user,
    },
  };
}

async function startAuthServer(prisma = makePrisma(), options = {}) {
  const app = createApp(prisma, {
    jwtSecret: TEST_SECRET,
    registrationOrganizationId: "org-approved",
    ...options,
  });
  return startServer(app);
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
});

test("registration hashes the password and returns only safe user fields", async () => {
  let createdData;
  const baseUrl = await startAuthServer(makePrisma({
    user: {
      create: async ({ data }) => {
        createdData = data;
        return { id: "user-1", createdAt: new Date("2026-01-01T00:00:00Z"), ...data };
      },
    },
  }));

  const { response, json } = await post(baseUrl, "/api/auth/register", {
    name: "  Sam Student  ",
    email: " Sam@Example.edu ",
    password: TEST_PASSWORD,
  });

  assert.equal(response.status, 201);
  assert.equal(createdData.name, "Sam Student");
  assert.equal(createdData.email, "sam@example.edu");
  assert.equal(createdData.role, "STUDENT");
  assert.equal(createdData.organizationId, "org-approved");
  assert.notEqual(createdData.password, TEST_PASSWORD);
  assert.equal(await bcrypt.compare(TEST_PASSWORD, createdData.password), true);
  assert.equal(json.data.user.email, "sam@example.edu");
  assert.equal(json.data.user.role, "STUDENT");
  assert.equal("password" in json.data.user, false);
  assert.doesNotMatch(JSON.stringify(json), /correct-horse-battery|\$2[aby]\$/);
});

test("registration rejects client-supplied role or organization", async () => {
  const prisma = makePrisma({
    user: { create: async () => assert.fail("user must not be created") },
  });
  const baseUrl = await startAuthServer(prisma);

  const { response, json } = await post(baseUrl, "/api/auth/register", {
    name: "Sam",
    email: "sam@example.edu",
    password: TEST_PASSWORD,
    role: "ADMIN",
    organizationId: "org-attacker-selected",
  });

  assert.equal(response.status, 400);
  assert.equal(json.success, false);
});

test("registration requires an administrator-configured organization", async () => {
  const baseUrl = await startAuthServer(makePrisma(), { registrationOrganizationId: "" });
  const { response, json } = await post(baseUrl, "/api/auth/register", {
    name: "Sam",
    email: "sam@example.edu",
    password: TEST_PASSWORD,
  });

  assert.equal(response.status, 503);
  assert.deepEqual(json, { success: false, message: "Registration is not configured" });
});

test("duplicate email registration returns HTTP 409", async () => {
  const duplicateError = Object.assign(new Error("private database detail"), { code: "P2002" });
  const prisma = makePrisma({ user: { create: async () => { throw duplicateError; } } });
  const baseUrl = await startAuthServer(prisma);

  const { response, json } = await post(baseUrl, "/api/auth/register", {
    name: "Sam",
    email: "sam@example.edu",
    password: TEST_PASSWORD,
  });

  assert.equal(response.status, 409);
  assert.deepEqual(json, { success: false, message: "An account with this email already exists" });
  assert.doesNotMatch(JSON.stringify(json), /private database detail/);
});

test("login succeeds with the password and issues a signed JWT", async () => {
  const storedHash = await bcrypt.hash(TEST_PASSWORD, 4);
  const user = {
    id: "user-1",
    name: "Sam Student",
    email: "sam@example.edu",
    password: storedHash,
    role: "FACULTY",
    organizationId: "org-approved",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  const baseUrl = await startAuthServer(makePrisma({
    user: { findUnique: async ({ where }) => where.email === user.email ? user : null },
  }));

  const { response, json } = await post(baseUrl, "/api/auth/login", {
    email: " SAM@example.edu ",
    password: TEST_PASSWORD,
  });

  assert.equal(response.status, 200);
  assert.equal(json.success, true);
  assert.equal("password" in json.data.user, false);
  assert.doesNotMatch(JSON.stringify(json), /correct-horse-battery|\$2[aby]\$/);
  const claims = jwt.verify(json.data.token, TEST_SECRET, { algorithms: ["HS256"] });
  assert.equal(claims.sub, "user-1");
  assert.equal(claims.role, "FACULTY");
  assert.equal(claims.organizationId, "org-approved");
});

test("login failure gives the same response for an unknown user and a wrong password", async () => {
  const storedHash = await bcrypt.hash(TEST_PASSWORD, 4);
  const user = { email: "sam@example.edu", password: storedHash };
  const baseUrl = await startAuthServer(makePrisma({
    user: { findUnique: async ({ where }) => where.email === user.email ? user : null },
  }));

  const wrongPassword = await post(baseUrl, "/api/auth/login", {
    email: "sam@example.edu",
    password: "incorrect-password",
  });
  const unknownUser = await post(baseUrl, "/api/auth/login", {
    email: "missing@example.edu",
    password: TEST_PASSWORD,
  });

  assert.equal(wrongPassword.response.status, 401);
  assert.equal(unknownUser.response.status, 401);
  assert.deepEqual(wrongPassword.json, unknownUser.json);
});

test("login rejects passwords longer than bcrypt's 72-byte limit", async () => {
  let lookedUpUser = false;
  const baseUrl = await startAuthServer(makePrisma({
    user: {
      findUnique: async () => {
        lookedUpUser = true;
        return null;
      },
    },
  }));
  const { response, json } = await post(baseUrl, "/api/auth/login", {
    email: "sam@example.edu",
    password: "p".repeat(73),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(json, { success: false, message: "Email or password is invalid" });
  assert.equal(lookedUpUser, false);
});

test("GET /api/auth/me returns a safe profile scoped to the token organization", async () => {
  let query;
  const profile = {
    id: "user-1",
    name: "Sam Student",
    email: "sam@example.edu",
    password: "hash-that-must-not-be-returned",
    role: "STUDENT",
    organizationId: "org-from-token",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  const prisma = makePrisma({
    user: {
      findFirst: async (args) => {
        query = args;
        return profile;
      },
    },
  });
  const baseUrl = await startAuthServer(prisma);
  const token = jwt.sign(
    { role: "STUDENT", organizationId: "org-from-token" },
    TEST_SECRET,
    { subject: "user-1", expiresIn: "1h", algorithm: "HS256" },
  );

  const { response, json } = await get(
    baseUrl,
    "/api/auth/me?organizationId=org-client-selected&userId=another-user",
    token,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(query.where, { id: "user-1", organizationId: "org-from-token" });
  assert.equal(query.select.password, undefined);
  assert.deepEqual(json.data.user, {
    id: "user-1",
    name: "Sam Student",
    email: "sam@example.edu",
    role: "STUDENT",
    organizationId: "org-from-token",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(json), /hash-that-must-not-be-returned|correct-horse-battery|eyJ[a-zA-Z0-9_-]+\./);
});

test("GET /api/auth/me rejects a token without a matching database user in its organization", async () => {
  let query;
  const baseUrl = await startAuthServer(makePrisma({
    user: {
      findFirst: async (args) => {
        query = args;
        return null;
      },
    },
  }));
  const token = jwt.sign(
    { role: "STUDENT", organizationId: "org-attacker" },
    TEST_SECRET,
    { subject: "user-1", expiresIn: "1h", algorithm: "HS256" },
  );

  const { response, json } = await get(baseUrl, "/api/auth/me", token);

  assert.equal(response.status, 401);
  assert.deepEqual(query.where, { id: "user-1", organizationId: "org-attacker" });
  assert.deepEqual(json, { success: false, message: "Invalid or expired token" });
});

test("role authorization permits only the requested roles", async () => {
  const app = express();
  const authenticate = createAuthMiddleware(TEST_SECRET);
  app.get("/admin", authenticate, requireRole("ADMIN"), (req, res) => res.json({ role: req.user.role }));
  app.get("/faculty", authenticate, requireRole("FACULTY"), (req, res) => res.json({ role: req.user.role }));
  app.get("/student", authenticate, requireRole("STUDENT"), (req, res) => res.json({ role: req.user.role }));
  const baseUrl = await startServer(app);

  for (const allowedRole of ["ADMIN", "FACULTY", "STUDENT"]) {
    const path = `/${allowedRole.toLowerCase()}`;
    const token = jwt.sign(
      { role: allowedRole, organizationId: "org-1" },
      TEST_SECRET,
      { subject: "user-1", expiresIn: "1h", algorithm: "HS256" },
    );
    const allowed = await get(baseUrl, path, token);
    assert.equal(allowed.response.status, 200, `${allowedRole} should access ${path}`);

    for (const deniedRole of ["ADMIN", "FACULTY", "STUDENT"].filter((role) => role !== allowedRole)) {
      const deniedToken = jwt.sign(
        { role: deniedRole, organizationId: "org-1" },
        TEST_SECRET,
        { subject: "user-2", expiresIn: "1h", algorithm: "HS256" },
      );
      const denied = await get(baseUrl, path, deniedToken);
      assert.equal(denied.response.status, 403, `${deniedRole} should not access ${path}`);
      assert.deepEqual(denied.json, { success: false, message: "Forbidden" });
    }
  }
});

test("authentication middleware attaches identity claims from a valid token", async () => {
  const app = express();
  app.use(express.json());
  app.get("/protected", createAuthMiddleware(TEST_SECRET), (req, res) => {
    res.json({ user: req.user });
  });
  const baseUrl = await startServer(app);
  const token = jwt.sign(
    { role: "STUDENT", organizationId: "org-from-token" },
    TEST_SECRET,
    { subject: "user-from-token", expiresIn: "1h", algorithm: "HS256" },
  );

  const response = await fetch(`${baseUrl}/protected?role=ADMIN`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(json.user, {
    id: "user-from-token",
    role: "STUDENT",
    organizationId: "org-from-token",
  });
});

test("authentication middleware rejects invalid and missing bearer tokens", async () => {
  const app = express();
  app.get("/protected", createAuthMiddleware(TEST_SECRET), (req, res) => res.json({ user: req.user }));
  const baseUrl = await startServer(app);
  const badToken = jwt.sign(
    { role: "STUDENT", organizationId: "org-1" },
    "a-different-secret",
    { subject: "user-1", algorithm: "HS256" },
  );
  const expiredToken = jwt.sign(
    { role: "STUDENT", organizationId: "org-1" },
    TEST_SECRET,
    { subject: "user-1", expiresIn: -1, algorithm: "HS256" },
  );

  const invalid = await fetch(`${baseUrl}/protected`, { headers: { Authorization: `Bearer ${badToken}` } });
  const malformed = await fetch(`${baseUrl}/protected`, { headers: { Authorization: "Bearer not-a-jwt" } });
  const expired = await fetch(`${baseUrl}/protected`, { headers: { Authorization: `Bearer ${expiredToken}` } });
  const malformedHeader = await fetch(`${baseUrl}/protected`, { headers: { Authorization: "Bearer one two" } });
  const missing = await fetch(`${baseUrl}/protected`);

  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { success: false, message: "Invalid or expired token" });
  assert.equal(malformed.status, 401);
  assert.deepEqual(await malformed.json(), { success: false, message: "Invalid or expired token" });
  assert.equal(expired.status, 401);
  assert.deepEqual(await expired.json(), { success: false, message: "Invalid or expired token" });
  assert.equal(malformedHeader.status, 401);
  assert.deepEqual(await malformedHeader.json(), { success: false, message: "Authentication required" });
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { success: false, message: "Authentication required" });
});

test("browser CORS allows only configured frontend origins", async () => {
  const previousOrigins = process.env.FRONTEND_ORIGINS;
  process.env.FRONTEND_ORIGINS = "https://frontend.example.test";
  const app = createApp(makePrisma(), { jwtSecret: TEST_SECRET });
  if (previousOrigins === undefined) delete process.env.FRONTEND_ORIGINS;
  else process.env.FRONTEND_ORIGINS = previousOrigins;

  const baseUrl = await startServer(app);
  const trusted = await fetch(`${baseUrl}/api/departments`, { headers: { Origin: "https://frontend.example.test" } });
  const untrusted = await fetch(`${baseUrl}/api/departments`, { headers: { Origin: "https://attacker.example.test" } });

  assert.equal(trusted.headers.get("access-control-allow-origin"), "https://frontend.example.test");
  assert.equal(untrusted.headers.get("access-control-allow-origin"), null);
});

test("authentication endpoints return a consistent 429 after the configured request limit", async () => {
  const baseUrl = await startAuthServer(makePrisma(), {
    authRateLimitWindowMs: 60_000,
    authRateLimitMax: 2,
  });
  const body = { email: "unknown@example.edu", password: TEST_PASSWORD };

  const first = await post(baseUrl, "/api/auth/login", body);
  const second = await post(baseUrl, "/api/auth/login", body);
  const limited = await post(baseUrl, "/api/auth/login", body);

  assert.equal(first.response.status, 401);
  assert.equal(second.response.status, 401);
  assert.equal(limited.response.status, 429);
  assert.equal(limited.json.success, false);
  assert.equal(limited.json.message, "Too many authentication requests. Try again later.");
  assert.ok(limited.response.headers.get("ratelimit"));
});

test("unknown routes and malformed JSON return consistent JSON errors", async () => {
  const baseUrl = await startAuthServer();
  const missing = await fetch(`${baseUrl}/api/does-not-exist`);
  const malformed = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{invalid-json",
  });

  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { success: false, message: "Route not found" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { success: false, message: "Request body must contain valid JSON" });
});
