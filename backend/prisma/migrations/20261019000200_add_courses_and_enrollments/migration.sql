-- Add course management without altering existing Organization, User, or Department rows.
CREATE TYPE "CourseStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- Composite unique indexes let PostgreSQL enforce that related records share a tenant.
CREATE UNIQUE INDEX "User_id_organizationId_key"
    ON "User"("id", "organizationId");

CREATE UNIQUE INDEX "Department_id_organizationId_key"
    ON "Department"("id", "organizationId");

CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "capacity" INTEGER NOT NULL DEFAULT 100,
    "status" "CourseStatus" NOT NULL DEFAULT 'DRAFT',
    "organizationId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "facultyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Course_id_organizationId_key"
    ON "Course"("id", "organizationId");

CREATE UNIQUE INDEX "Course_organizationId_code_key"
    ON "Course"("organizationId", "code");

CREATE INDEX "Course_organizationId_status_createdAt_idx"
    ON "Course"("organizationId", "status", "createdAt");

CREATE INDEX "Course_organizationId_facultyId_idx"
    ON "Course"("organizationId", "facultyId");

CREATE INDEX "Course_organizationId_departmentId_idx"
    ON "Course"("organizationId", "departmentId");

ALTER TABLE "Course"
    ADD CONSTRAINT "Course_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Course"
    ADD CONSTRAINT "Course_departmentId_organizationId_fkey"
    FOREIGN KEY ("departmentId", "organizationId") REFERENCES "Department"("id", "organizationId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Course"
    ADD CONSTRAINT "Course_facultyId_organizationId_fkey"
    FOREIGN KEY ("facultyId", "organizationId") REFERENCES "User"("id", "organizationId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Enrollment_courseId_studentId_key"
    ON "Enrollment"("courseId", "studentId");

CREATE INDEX "Enrollment_organizationId_studentId_enrolledAt_idx"
    ON "Enrollment"("organizationId", "studentId", "enrolledAt");

ALTER TABLE "Enrollment"
    ADD CONSTRAINT "Enrollment_courseId_organizationId_fkey"
    FOREIGN KEY ("courseId", "organizationId") REFERENCES "Course"("id", "organizationId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Enrollment"
    ADD CONSTRAINT "Enrollment_studentId_organizationId_fkey"
    FOREIGN KEY ("studentId", "organizationId") REFERENCES "User"("id", "organizationId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
