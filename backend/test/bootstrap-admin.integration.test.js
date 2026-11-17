const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const bcrypt = require("bcrypt");
require("./helpers/integrationDatabaseGuard").loadAndAssertIntegrationDatabase();
const prisma = require("../src/prisma");
const { bootstrapAdmin } = require("../src/services/bootstrapAdmin");

const created = { organizationId: null, emails: [] };

after(async () => {
  if (created.emails.length) {
    await prisma.user.deleteMany({ where: { email: { in: created.emails } } });
  }
  if (created.organizationId) {
    await prisma.organization.deleteMany({ where: { id: created.organizationId } });
  }
  await prisma.$disconnect();
});

test("PostgreSQL advisory locking permits only one concurrent bootstrap administrator", async () => {
  await prisma.$connect();
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: { name: `Bootstrap integration ${suffix}`, slug: `bootstrap-${suffix}` },
    select: { id: true },
  });
  created.organizationId = organization.id;

  const inputs = ["first", "second"].map((label) => {
    const email = `bootstrap-${label}-${suffix}@integration.invalid`;
    created.emails.push(email);
    return {
      organizationId: organization.id,
      name: `Bootstrap ${label}`,
      email,
      password: randomBytes(24).toString("base64url"),
    };
  });

  const results = await Promise.allSettled(inputs.map((input) => bootstrapAdmin(prisma, input)));
  const successes = results.filter((result) => result.status === "fulfilled");
  const failures = results.filter((result) => result.status === "rejected");

  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason.code, "ADMIN_ALREADY_EXISTS");

  const administrators = await prisma.user.findMany({
    where: { organizationId: organization.id, role: "ADMIN" },
    select: { id: true, email: true, password: true },
  });
  assert.equal(administrators.length, 1);
  const winningInput = inputs.find((input) => input.email === administrators[0].email);
  assert.ok(winningInput);
  assert.equal(await bcrypt.compare(winningInput.password, administrators[0].password), true);
  assert.notEqual(administrators[0].password, winningInput.password);

  await assert.rejects(bootstrapAdmin(prisma, winningInput), (error) => error.code === "ADMIN_ALREADY_EXISTS");
  const afterRepeat = await prisma.user.count({ where: { organizationId: organization.id, role: "ADMIN" } });
  assert.equal(afterRepeat, 1);
});
