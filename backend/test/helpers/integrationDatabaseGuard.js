const path = require("node:path");

const EXPECTED_DATABASE_NAME = "campusflow_test";
const REFUSAL_MESSAGE = "PostgreSQL integration tests only run against the campusflow_test database.";

function getPostgresDatabaseName(connectionString) {
  if (typeof connectionString !== "string" || !connectionString) return null;

  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    const encodedName = url.pathname.replace(/^\/+/, "").split("/")[0];
    if (!encodedName) return null;
    const pathName = decodeURIComponent(encodedName);
    const queryDatabaseName = url.searchParams.get("dbname");
    if (queryDatabaseName && decodeURIComponent(queryDatabaseName) !== pathName) return null;
    return pathName;
  } catch {
    return null;
  }
}

function assertIntegrationDatabaseName(connectionString) {
  if (getPostgresDatabaseName(connectionString) !== EXPECTED_DATABASE_NAME) {
    throw new Error(REFUSAL_MESSAGE);
  }
  return EXPECTED_DATABASE_NAME;
}

function loadAndAssertIntegrationDatabase() {
  require("dotenv").config({
    path: path.resolve(__dirname, "../../.env"),
    quiet: true,
  });
  return assertIntegrationDatabaseName(process.env.DATABASE_URL);
}

module.exports = {
  EXPECTED_DATABASE_NAME,
  REFUSAL_MESSAGE,
  getPostgresDatabaseName,
  assertIntegrationDatabaseName,
  loadAndAssertIntegrationDatabase,
};
