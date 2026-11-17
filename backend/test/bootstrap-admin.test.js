const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const bcrypt = require("bcrypt");
const { BootstrapAdminError, bootstrapAdmin, validateBootstrapInput } = require("../src/services/bootstrapAdmin");
const { inputFromEnvironment } = require("../scripts/bootstrap-admin");

const validInput = {
  organizationId: " org-1 ",
  name: " Campus Administrator ",
  email: "  FIRST.ADMIN@example.edu ",
  password: randomBytes(24).toString("base64url"),
};

function makePrisma({ organization = { id: "org-1" }, existingAdmin = null, createError = null } = {}) {
  const state = { calls: [], createdData: [], admin: existingAdmin };
  const tx = {
    $queryRaw: async (strings, ...values) => {
      state.calls.push({ type: "lock", query: strings.join("?"), values });
      return [];
    },
    organization: {
      findUnique: async (args) => {
        state.calls.push({ type: "organization", args });
        return organization;
      },
    },
    user: {
      findFirst: async (args) => {
        state.calls.push({ type: "existing-admin", args });
        return state.admin;
      },
      create: async ({ data, select }) => {
        state.calls.push({ type: "create", select });
        state.createdData.push(data);
        if (createError) throw createError;
        state.admin = { id: "created-admin" };
        return { id: state.admin.id };
      },
    },
  };

  return {
    state,
    prisma: { $transaction: async (callback) => callback(tx) },
  };
}

test("bootstrap creates a tenant ADMIN with the shared bcrypt hash policy", async () => {
  const { prisma, state } = makePrisma();
  const result = await bootstrapAdmin(prisma, validInput);
  const created = state.createdData[0];

  assert.deepEqual(result, { created: true });
  assert.deepEqual(state.calls.map((call) => call.type), ["lock", "organization", "existing-admin", "create"]);
  assert.match(state.calls[0].query, /pg_advisory_xact_lock/);
  assert.deepEqual(state.calls[0].values, ["org-1", "campusflow-bootstrap-admin"]);
  assert.deepEqual(state.calls[1].args, { where: { id: "org-1" }, select: { id: true } });
  assert.deepEqual(state.calls[2].args, {
    where: { organizationId: "org-1", role: "ADMIN" },
    select: { id: true },
  });
  assert.equal(created.name, "Campus Administrator");
  assert.equal(created.email, "first.admin@example.edu");
  assert.equal(created.role, "ADMIN");
  assert.equal(created.organizationId, "org-1");
  assert.notEqual(created.password, validInput.password);
  assert.equal(await bcrypt.compare(validInput.password, created.password), true);
  assert.match(created.password, /^\$2[aby]\$12\$/);
  assert.equal("password" in result, false);
  assert.equal("passwordHash" in result, false);
});

test("bootstrap refuses a missing organization without creating a user", async () => {
  const { prisma, state } = makePrisma({ organization: null });

  await assert.rejects(bootstrapAdmin(prisma, validInput), (error) => {
    assert.ok(error instanceof BootstrapAdminError);
    assert.equal(error.code, "ORGANIZATION_NOT_FOUND");
    return true;
  });
  assert.equal(state.createdData.length, 0);
});

test("duplicate global email is handled without exposing database details", async () => {
  const { prisma, state } = makePrisma({ createError: { code: "P2002", meta: { target: ["email"] } } });

  await assert.rejects(bootstrapAdmin(prisma, validInput), (error) => {
    assert.equal(error.code, "DUPLICATE_EMAIL");
    assert.doesNotMatch(error.message, /P2002|first\.admin@example\.edu/);
    return true;
  });
  assert.equal(state.createdData.length, 1);
});

test("bootstrap enforces the same minimum and bcrypt byte limit as registration", async () => {
  assert.throws(
    () => validateBootstrapInput({ ...validInput, password: "short" }),
    (error) => error.code === "INVALID_PASSWORD",
  );
  assert.throws(
    () => validateBootstrapInput({ ...validInput, password: "é".repeat(37) }),
    (error) => error.code === "INVALID_PASSWORD",
  );

  const { prisma, state } = makePrisma();
  await assert.rejects(
    bootstrapAdmin(prisma, { ...validInput, password: "short" }),
    (error) => error.code === "INVALID_PASSWORD",
  );
  assert.equal(state.calls.length, 0);
});

test("bootstrap refuses to replace an existing tenant administrator", async () => {
  const existingAdmin = { id: "existing-admin" };
  const { prisma, state } = makePrisma({ existingAdmin });

  await assert.rejects(bootstrapAdmin(prisma, validInput), (error) => {
    assert.equal(error.code, "ADMIN_ALREADY_EXISTS");
    assert.match(error.message, /no users were changed/);
    return true;
  });
  assert.equal(state.createdData.length, 0);
  assert.equal(state.admin, existingAdmin);
});

test("a repeated bootstrap attempt is refused after the first succeeds", async () => {
  const { prisma, state } = makePrisma();

  await bootstrapAdmin(prisma, validInput);
  await assert.rejects(bootstrapAdmin(prisma, validInput), (error) => error.code === "ADMIN_ALREADY_EXISTS");

  assert.equal(state.createdData.length, 1);
  assert.equal(state.calls.filter((call) => call.type === "lock").length, 2);
});

test("bootstrap input requires an explicit organization, name, and valid normalized email", () => {
  assert.throws(() => validateBootstrapInput({ ...validInput, organizationId: " " }), (error) => error.code === "ORGANIZATION_ID_REQUIRED");
  assert.throws(() => validateBootstrapInput({ ...validInput, name: " " }), (error) => error.code === "INVALID_NAME");
  assert.throws(() => validateBootstrapInput({ ...validInput, email: "not-an-email" }), (error) => error.code === "INVALID_EMAIL");
  assert.deepEqual(validateBootstrapInput(validInput), {
    organizationId: "org-1",
    name: "Campus Administrator",
    email: "first.admin@example.edu",
    password: validInput.password,
  });
});

test("CLI input is sourced only from explicit bootstrap environment variables", () => {
  assert.throws(() => inputFromEnvironment({}), (error) => error.code === "ORGANIZATION_ID_REQUIRED");
  assert.deepEqual(inputFromEnvironment({
    BOOTSTRAP_ORGANIZATION_ID: "org-1",
    BOOTSTRAP_ADMIN_NAME: "Campus Administrator",
    BOOTSTRAP_ADMIN_EMAIL: "ADMIN@example.edu",
    BOOTSTRAP_ADMIN_PASSWORD: validInput.password,
  }), {
    organizationId: "org-1",
    name: "Campus Administrator",
    email: "admin@example.edu",
    password: validInput.password,
  });
});
