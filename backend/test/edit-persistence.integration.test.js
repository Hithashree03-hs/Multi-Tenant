const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("./helpers/integrationDatabaseGuard").loadAndAssertIntegrationDatabase();
const { createApp } = require("../src/app");
const prisma = require("../src/prisma");

const created = { organizationIds: [], userIds: [], departmentIds: [], courseIds: [] };
let server;

async function cleanup() {
  if (created.courseIds.length) await prisma.course.deleteMany({ where: { id: { in: created.courseIds } } });
  if (created.departmentIds.length) await prisma.department.deleteMany({ where: { id: { in: created.departmentIds } } });
  if (created.userIds.length) await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  if (created.organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: created.organizationIds } } });
}

async function request(baseUrl, secret, user, method, path, body) {
  const token = jwt.sign(
    { role: user.role, organizationId: user.organizationId },
    secret,
    { subject: user.id, expiresIn: "5m", algorithm: "HS256" },
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

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await cleanup();
  await prisma.$disconnect();
});

test("PostgreSQL edit routes persist partial organization and course updates safely", async () => {
  await prisma.$connect();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 16);
  const secret = randomBytes(32).toString("hex");
  const platformSecret = randomBytes(32).toString("hex");
  const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 4);

  const organizationA = await prisma.organization.create({
    data: { name: `Edit Test A ${suffix}`, slug: `edit-test-a-${suffix}` },
    select: { id: true, name: true, slug: true },
  });
  created.organizationIds.push(organizationA.id);
  const organizationB = await prisma.organization.create({
    data: { name: `Edit Test B ${suffix}`, slug: `edit-test-b-${suffix}` },
    select: { id: true, name: true, slug: true },
  });
  created.organizationIds.push(organizationB.id);

  async function createUser(organizationId, role, localName) {
    const user = await prisma.user.create({
      data: {
        name: `${localName} ${suffix}`,
        email: `${localName.toLowerCase()}-${suffix}@integration.invalid`,
        password: passwordHash,
        role,
        organizationId,
      },
      select: { id: true, role: true, organizationId: true },
    });
    created.userIds.push(user.id);
    return user;
  }

  const adminA = await createUser(organizationA.id, "ADMIN", "AdminA");
  const adminB = await createUser(organizationB.id, "ADMIN", "AdminB");
  const facultyA = await createUser(organizationA.id, "FACULTY", "FacultyA");
  const departmentA = await prisma.department.create({
    data: { name: `Edit Test Department ${suffix}`, code: `EDT${suffix.slice(0, 8).toUpperCase()}`, organizationId: organizationA.id },
    select: { id: true },
  });
  created.departmentIds.push(departmentA.id);
  const departmentB = await prisma.department.create({
    data: { name: `Other Edit Department ${suffix}`, code: `OTH${suffix.slice(0, 8).toUpperCase()}`, organizationId: organizationB.id },
    select: { id: true },
  });
  created.departmentIds.push(departmentB.id);

  const courseA = await prisma.course.create({
    data: {
      code: `EDIT-${suffix.slice(0, 8).toUpperCase()}`,
      title: `Original course ${suffix}`,
      description: "Keep this description",
      capacity: 37,
      status: "PUBLISHED",
      organizationId: organizationA.id,
      departmentId: departmentA.id,
      facultyId: facultyA.id,
    },
    select: { id: true },
  });
  created.courseIds.push(courseA.id);
  const courseB = await prisma.course.create({
    data: {
      code: `OTHR-${suffix.slice(0, 8).toUpperCase()}`,
      title: `Other organization course ${suffix}`,
      organizationId: organizationB.id,
      departmentId: departmentB.id,
    },
    select: { id: true },
  });
  created.courseIds.push(courseB.id);

  server = createApp(prisma, { jwtSecret: secret, platformAdminSecret: platformSecret }).listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const duplicateOrganization = await fetch(`${baseUrl}/api/organizations`, {
    method: "POST",
    headers: { "x-platform-admin-key": platformSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Duplicate slug ${suffix}`, slug: organizationA.slug }),
  });
  assert.equal(duplicateOrganization.status, 409);
  assert.deepEqual(await duplicateOrganization.json(), {
    success: false,
    message: "An organization with this slug already exists",
  });
  const unchangedOrganization = await prisma.organization.findUnique({ where: { id: organizationA.id } });
  assert.equal(unchangedOrganization.name, organizationA.name);
  assert.equal(unchangedOrganization.slug, organizationA.slug);

  const tenantCreateSlug = `tenant-create-${suffix}`;
  const tenantCreate = await request(baseUrl, secret, adminA, "POST", "/api/organizations", {
    name: `Unauthorized tenant create ${suffix}`,
    slug: tenantCreateSlug,
  });
  if (tenantCreate.json?.data?.id) created.organizationIds.push(tenantCreate.json.data.id);
  assert.equal(tenantCreate.response.status, 403);
  const unintendedOrganization = await prisma.organization.findUnique({ where: { slug: tenantCreateSlug }, select: { id: true } });
  if (unintendedOrganization) created.organizationIds.push(unintendedOrganization.id);
  assert.equal(unintendedOrganization, null);

  const nameUpdate = await request(baseUrl, secret, adminA, "PATCH", `/api/organizations/${organizationA.id}`, { name: `Renamed ${suffix}` });
  assert.equal(nameUpdate.response.status, 200);
  assert.equal(nameUpdate.json.data.name, `Renamed ${suffix}`);
  assert.equal(nameUpdate.json.data.slug, organizationA.slug);
  let persistedOrganization = await prisma.organization.findUnique({ where: { id: organizationA.id } });
  assert.equal(persistedOrganization.name, `Renamed ${suffix}`);
  assert.equal(persistedOrganization.slug, organizationA.slug);

  const slugUpdate = await request(baseUrl, secret, adminA, "PATCH", `/api/organizations/${organizationA.id}`, { slug: `renamed-${suffix}` });
  assert.equal(slugUpdate.response.status, 200);
  assert.equal(slugUpdate.json.data.name, `Renamed ${suffix}`);
  assert.equal(slugUpdate.json.data.slug, `renamed-${suffix}`);
  const organizationFetch = await request(baseUrl, secret, adminA, "GET", `/api/organizations/${organizationA.id}`);
  assert.equal(organizationFetch.response.status, 200);
  assert.equal(organizationFetch.json.data.name, `Renamed ${suffix}`);
  assert.equal(organizationFetch.json.data.slug, `renamed-${suffix}`);

  const invalidOrganization = await request(baseUrl, secret, adminA, "PATCH", `/api/organizations/${organizationA.id}`, { name: "  " });
  assert.equal(invalidOrganization.response.status, 400);
  const crossOrganization = await request(baseUrl, secret, adminA, "PATCH", `/api/organizations/${organizationB.id}`, { name: `Unauthorized ${suffix}` });
  assert.equal(crossOrganization.response.status, 404);
  persistedOrganization = await prisma.organization.findUnique({ where: { id: organizationB.id } });
  assert.equal(persistedOrganization.name, organizationB.name);
  assert.equal(persistedOrganization.slug, organizationB.slug);

  const titleUpdate = await request(baseUrl, secret, adminA, "PATCH", `/api/courses/${courseA.id}`, { title: `Updated course ${suffix}` });
  assert.equal(titleUpdate.response.status, 200);
  assert.equal(titleUpdate.json.data.id, courseA.id);
  assert.equal(titleUpdate.json.data.title, `Updated course ${suffix}`);
  assert.equal(titleUpdate.json.data.code, `EDIT-${suffix.slice(0, 8).toUpperCase()}`);
  assert.equal(titleUpdate.json.data.description, "Keep this description");
  assert.equal(titleUpdate.json.data.capacity, 37);
  assert.equal(titleUpdate.json.data.status, "PUBLISHED");
  assert.equal(titleUpdate.json.data.departmentId, departmentA.id);
  assert.equal(titleUpdate.json.data.facultyId, facultyA.id);

  const descriptionUpdate = await request(baseUrl, secret, adminA, "PATCH", `/api/courses/${courseA.id}`, { description: null });
  assert.equal(descriptionUpdate.response.status, 200);
  assert.equal(descriptionUpdate.json.data.description, null);
  const courseFetch = await request(baseUrl, secret, adminA, "GET", `/api/courses/${courseA.id}`);
  assert.equal(courseFetch.response.status, 200);
  assert.deepEqual(courseFetch.json.data, descriptionUpdate.json.data);
  const persistedCourse = await prisma.course.findUnique({ where: { id: courseA.id } });
  assert.equal(persistedCourse.title, `Updated course ${suffix}`);
  assert.equal(persistedCourse.description, null);
  assert.equal(persistedCourse.code, `EDIT-${suffix.slice(0, 8).toUpperCase()}`);
  assert.equal(persistedCourse.capacity, 37);
  assert.equal(persistedCourse.status, "PUBLISHED");
  assert.equal(persistedCourse.departmentId, departmentA.id);
  assert.equal(persistedCourse.facultyId, facultyA.id);
  const invalidCourse = await request(baseUrl, secret, adminA, "PATCH", `/api/courses/${courseA.id}`, { title: "  " });
  assert.equal(invalidCourse.response.status, 400);

  const crossCourse = await request(baseUrl, secret, adminA, "PATCH", `/api/courses/${courseB.id}`, { title: "Unauthorized" });
  assert.equal(crossCourse.response.status, 404);
  const persistedOtherCourse = await prisma.course.findUnique({ where: { id: courseB.id } });
  assert.equal(persistedOtherCourse.title, `Other organization course ${suffix}`);

  const ownOrgOtherAdmin = await request(baseUrl, secret, adminB, "GET", `/api/organizations/${organizationB.id}`);
  assert.equal(ownOrgOtherAdmin.response.status, 200);
});
