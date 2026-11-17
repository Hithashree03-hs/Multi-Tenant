const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("./helpers/integrationDatabaseGuard").loadAndAssertIntegrationDatabase();
const createApp = require("../src/app").createApp;

const prisma = require("../src/prisma");
const created = { organizationIds: [], departmentIds: [], userIds: [] };
let server;

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (created.userIds.length) await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  if (created.departmentIds.length) await prisma.department.deleteMany({ where: { id: { in: created.departmentIds } } });
  if (created.organizationIds.length) {
    await prisma.organization.deleteMany({ where: { id: { in: created.organizationIds } } });
  }
  await prisma.$disconnect();
});

test("real PostgreSQL enforces tenant-scoped department reads and writes", async () => {
  await prisma.$connect();
  const suffix = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const passwordHash = await bcrypt.hash("integration-only-test-password", 4);

  const orgA = await prisma.organization.create({
    data: { name: `Integration A ${suffix}`, slug: `integration-a-${suffix}` },
    select: { id: true },
  });
  created.organizationIds.push(orgA.id);
  const orgB = await prisma.organization.create({
    data: { name: `Integration B ${suffix}`, slug: `integration-b-${suffix}` },
    select: { id: true },
  });
  created.organizationIds.push(orgB.id);

  const userA = await prisma.user.create({
    data: {
      name: "Integration Admin A",
      email: `admin-a-${suffix}@integration.invalid`,
      password: passwordHash,
      role: "ADMIN",
      organizationId: orgA.id,
    },
    select: { id: true },
  });
  created.userIds.push(userA.id);
  const userB = await prisma.user.create({
    data: {
      name: "Integration Admin B",
      email: `admin-b-${suffix}@integration.invalid`,
      password: passwordHash,
      role: "ADMIN",
      organizationId: orgB.id,
    },
    select: { id: true },
  });
  created.userIds.push(userB.id);

  const departmentA = await prisma.department.create({
    data: { name: "Integration Department A", code: "IT-A", organizationId: orgA.id },
    select: { id: true },
  });
  created.departmentIds.push(departmentA.id);
  const departmentB = await prisma.department.create({
    data: { name: "Integration Department B", code: "IT-B", organizationId: orgB.id },
    select: { id: true },
  });
  created.departmentIds.push(departmentB.id);

  const app = createApp(prisma, { jwtSecret: secret });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tokenA = jwt.sign(
    { role: "STUDENT", organizationId: orgA.id },
    secret,
    { subject: userA.id, expiresIn: "1h", algorithm: "HS256" },
  );
  const headersA = { Authorization: `Bearer ${tokenA}` };

  const listResponse = await fetch(`${baseUrl}/api/departments?organizationId=${orgB.id}`, { headers: headersA });
  const listJson = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.deepEqual(listJson.data.map((department) => department.id), [departmentA.id]);

  const otherDepartment = await fetch(`${baseUrl}/api/departments/${departmentB.id}`, { headers: headersA });
  assert.equal(otherDepartment.status, 404);
  assert.deepEqual(await otherDepartment.json(), { success: false, message: "Department not found" });

  const crossTenantUpdate = await fetch(`${baseUrl}/api/departments/${departmentB.id}`, {
    method: "PATCH",
    headers: { ...headersA, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Should not change" }),
  });
  assert.equal(crossTenantUpdate.status, 404);

  const savedDepartment = await prisma.department.findUnique({ where: { id: departmentB.id } });
  assert.equal(savedDepartment.name, "Integration Department B");
});
