const { hashPassword } = require("../security/passwords");

const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LOCK_NAMESPACE = "campusflow-bootstrap-admin";

class BootstrapAdminError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BootstrapAdminError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BootstrapAdminError(code, message);
}

function validateBootstrapInput(input) {
  if (!input || typeof input !== "object") {
    fail("INVALID_INPUT", "Bootstrap details are required.");
  }

  const organizationId = typeof input.organizationId === "string" ? input.organizationId.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = input.password;

  if (!organizationId) {
    fail("ORGANIZATION_ID_REQUIRED", "An organization ID is required.");
  }
  if (!name || name.length > MAX_NAME_LENGTH) {
    fail("INVALID_NAME", `Administrator name must be between 1 and ${MAX_NAME_LENGTH} characters.`);
  }
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    fail("INVALID_EMAIL", "Administrator email address is invalid.");
  }
  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LENGTH ||
    Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES
  ) {
    fail(
      "INVALID_PASSWORD",
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters and no more than ${MAX_PASSWORD_BYTES} UTF-8 bytes.`,
    );
  }

  return { organizationId, name, email, password };
}

async function bootstrapAdmin(prisma, input) {
  const { organizationId, name, email, password } = validateBootstrapInput(input);

  await prisma.$transaction(async (tx) => {
    // The lock is transaction-scoped. Concurrent bootstrap attempts for the
    // same organization serialize before checking for an existing ADMIN.
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${LOCK_NAMESPACE}))) AS bootstrap_lock`;

    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) {
      fail("ORGANIZATION_NOT_FOUND", "The specified organization does not exist.");
    }

    const existingAdmin = await tx.user.findFirst({
      where: { organizationId, role: "ADMIN" },
      select: { id: true },
    });
    if (existingAdmin) {
      fail("ADMIN_ALREADY_EXISTS", "An administrator already exists for this organization; no users were changed.");
    }

    const passwordHash = await hashPassword(password);
    try {
      await tx.user.create({
        data: {
          name,
          email,
          password: passwordHash,
          role: "ADMIN",
          organizationId: organization.id,
        },
        select: { id: true },
      });
    } catch (error) {
      if (error && error.code === "P2002") {
        fail("DUPLICATE_EMAIL", "That email address already belongs to an account; no administrator was created.");
      }
      throw error;
    }
  });

  // Do not return the user row, password, or password hash to the CLI caller.
  return { created: true };
}

module.exports = { BootstrapAdminError, bootstrapAdmin, validateBootstrapInput };
