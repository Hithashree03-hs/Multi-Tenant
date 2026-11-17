require("dotenv").config();

const bcrypt = require("bcrypt");
const readline = require("readline");
const prisma = require("../src/prisma");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  const name = (await ask("Platform admin name: ")).trim();
  const email = (await ask("Platform admin email: ")).trim().toLowerCase();
  const password = await ask("Platform admin password (minimum 12 characters): ");

  if (!name || name.length > 120) {
    throw new Error("Enter a valid name.");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new Error("Enter a valid email.");
  }

  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("Password must be 12–72 UTF-8 bytes.");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.platformAdmin.create({
    data: { name, email, passwordHash },
    select: { id: true, name: true, email: true },
  });

  console.log("\nPlatform owner created successfully:");
  console.log(admin);
}

main()
  .catch((error) => {
    console.error("\nCould not create platform owner:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    rl.close();
    await prisma.$disconnect();
  });