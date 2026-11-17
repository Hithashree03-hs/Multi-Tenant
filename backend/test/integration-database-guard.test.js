const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  EXPECTED_DATABASE_NAME,
  REFUSAL_MESSAGE,
  assertIntegrationDatabaseName,
  getPostgresDatabaseName,
} = require("./helpers/integrationDatabaseGuard");

test("integration database guard accepts only the exact dedicated database name", () => {
  assert.equal(
    getPostgresDatabaseName("postgresql://test-user:test-password@localhost:5432/campusflow_test?schema=public"),
    EXPECTED_DATABASE_NAME,
  );
  assert.equal(
    assertIntegrationDatabaseName("postgres://test-user:test-password@localhost:5432/campusflow_test"),
    EXPECTED_DATABASE_NAME,
  );
});

test("integration database guard rejects development, lookalike, and invalid targets without echoing URLs", () => {
  for (const connectionString of [
    "postgresql://test-user:test-password@localhost:5432/campusflow",
    "postgresql://test-user:test-password@localhost:5432/campusflow_test_backup",
    "postgresql://test-user:test-password@localhost:5432/campusflow_test?dbname=campusflow",
    "not-a-postgres-url",
    undefined,
  ]) {
    let message = "";
    try {
      assertIntegrationDatabaseName(connectionString);
    } catch (error) {
      message = error.message;
    }
    assert.equal(message, REFUSAL_MESSAGE);
  }
});
