const { BootstrapAdminError, bootstrapAdmin, validateBootstrapInput } = require("../src/services/bootstrapAdmin");

function inputFromEnvironment(environment) {
  return validateBootstrapInput({
    organizationId: environment.BOOTSTRAP_ORGANIZATION_ID,
    name: environment.BOOTSTRAP_ADMIN_NAME,
    email: environment.BOOTSTRAP_ADMIN_EMAIL,
    password: environment.BOOTSTRAP_ADMIN_PASSWORD,
  });
}

function safeFailureMessage(error) {
  if (error instanceof BootstrapAdminError) return error.message;
  return "The operation could not be completed. Check database availability; credentials were not logged.";
}

async function main(environment = process.env) {
  let prisma;
  try {
    const input = inputFromEnvironment(environment);
    prisma = require("../src/prisma");
    await bootstrapAdmin(prisma, input);
    process.stdout.write("Bootstrap administrator created.\n");
    return 0;
  } catch (error) {
    process.stderr.write(`Bootstrap not completed: ${safeFailureMessage(error)}\n`);
    return 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stderr.write("Bootstrap not completed.\n");
    process.exitCode = 1;
  });
}

module.exports = { inputFromEnvironment, main };
