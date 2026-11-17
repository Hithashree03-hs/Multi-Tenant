

function validateOrganizationInput(environment) {
  const name = environment.CREATE_ORGANIZATION_NAME;
  const slug = environment.CREATE_ORGANIZATION_SLUG;

  if (typeof name !== "string" || typeof slug !== "string") {
    throw new Error(
      "Set CREATE_ORGANIZATION_NAME and CREATE_ORGANIZATION_SLUG."
    );
  }

  const normalizedName = name.trim();
  const normalizedSlug = slug.trim();

  if (
    !normalizedName ||
    normalizedName.length > 120 ||
    !normalizedSlug ||
    normalizedSlug.length > 63
  ) {
    throw new Error(
      "Name must contain 1–120 characters and slug 1–63 characters."
    );
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)) {
    throw new Error(
      "Slug must use lowercase letters, numbers, and single hyphens between words."
    );
  }

  return { name: normalizedName, slug: normalizedSlug };
}

function safeFailureMessage(error) {
  if (error?.code === "P2002") {
    return "That organization slug already exists. Choose a different slug.";
  }

  if (error instanceof Error && error.message.startsWith("Set ")) {
    return error.message;
  }

  if (
    error instanceof Error &&
    (error.message.startsWith("Name must") ||
      error.message.startsWith("Slug must"))
  ) {
    return error.message;
  }

  return "Organization creation failed. Check database availability; sensitive details were not logged.";
}

async function main(environment = process.env) {
  let prisma;

  try {
    const input = validateOrganizationInput(environment);

    // Load the project's configured Prisma client and DATABASE_URL.
    prisma = require("../src/prisma");

    const organization = await prisma.organization.create({
      data: input,
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
      },
    });

    process.stdout.write("Organization created successfully.\n");
    process.stdout.write(`Name: ${organization.name}\n`);
    process.stdout.write(`Slug: ${organization.slug}\n`);
    process.stdout.write(`Organization ID: ${organization.id}\n`);

    return 0;
  } catch (error) {
    console.error("Diagnostic:", {
  name: error?.name,
  code: error?.code,
  message: error?.message,
});

process.stderr.write(
  `Organization creation failed: ${safeFailureMessage(error)}\n`
);
    return 1;
  } finally {
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
  }
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.stderr.write("Organization creation failed.\n");
      process.exitCode = 1;
    });
}

module.exports = { validateOrganizationInput, main };
