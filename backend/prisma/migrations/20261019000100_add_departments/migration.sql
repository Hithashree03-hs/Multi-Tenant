-- Add tenant-owned departments without changing existing Organization or User rows.
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Department_organizationId_code_key"
    ON "Department"("organizationId", "code");

CREATE INDEX "Department_organizationId_createdAt_idx"
    ON "Department"("organizationId", "createdAt");

ALTER TABLE "Department"
    ADD CONSTRAINT "Department_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
