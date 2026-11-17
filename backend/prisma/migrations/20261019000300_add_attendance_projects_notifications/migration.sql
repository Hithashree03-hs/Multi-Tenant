-- Attendance, project collaboration, document metadata, and in-app notifications.
-- Existing records are not changed or removed by this additive migration.
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNING', 'ACTIVE', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "NotificationType" AS ENUM ('PROJECT_MEMBER_ADDED', 'TASK_ASSIGNED', 'COMMENT_ADDED', 'PROJECT_UPDATED');

CREATE UNIQUE INDEX "Enrollment_id_courseId_organizationId_key"
    ON "Enrollment"("id", "courseId", "organizationId");

CREATE TABLE "AttendanceSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AttendanceSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttendanceSession_id_courseId_organizationId_key"
    ON "AttendanceSession"("id", "courseId", "organizationId");
CREATE INDEX "AttendanceSession_organizationId_courseId_startsAt_idx"
    ON "AttendanceSession"("organizationId", "courseId", "startsAt");

ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_courseId_organizationId_fkey"
    FOREIGN KEY ("courseId", "organizationId") REFERENCES "Course"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_createdById_organizationId_fkey"
    FOREIGN KEY ("createdById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AttendanceRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "markedById" TEXT NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttendanceRecord_sessionId_enrollmentId_key"
    ON "AttendanceRecord"("sessionId", "enrollmentId");
CREATE INDEX "AttendanceRecord_organizationId_enrollmentId_markedAt_idx"
    ON "AttendanceRecord"("organizationId", "enrollmentId", "markedAt");

ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_sessionId_courseId_organizationId_fkey"
    FOREIGN KEY ("sessionId", "courseId", "organizationId") REFERENCES "AttendanceSession"("id", "courseId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_enrollmentId_courseId_organizationId_fkey"
    FOREIGN KEY ("enrollmentId", "courseId", "organizationId") REFERENCES "Enrollment"("id", "courseId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_markedById_organizationId_fkey"
    FOREIGN KEY ("markedById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PLANNING',
    "startsAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Project_id_organizationId_key" ON "Project"("id", "organizationId");
CREATE INDEX "Project_organizationId_status_createdAt_idx" ON "Project"("organizationId", "status", "createdAt");
CREATE INDEX "Project_organizationId_ownerId_idx" ON "Project"("organizationId", "ownerId");
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_organizationId_fkey"
    FOREIGN KEY ("ownerId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_createdById_organizationId_fkey"
    FOREIGN KEY ("createdById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");
CREATE INDEX "ProjectMember_organizationId_userId_addedAt_idx" ON "ProjectMember"("organizationId", "userId", "addedAt");
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_organizationId_fkey"
    FOREIGN KEY ("projectId", "organizationId") REFERENCES "Project"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_organizationId_fkey"
    FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "assigneeId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Task_id_projectId_organizationId_key" ON "Task"("id", "projectId", "organizationId");
CREATE INDEX "Task_organizationId_projectId_status_dueAt_idx" ON "Task"("organizationId", "projectId", "status", "dueAt");
CREATE INDEX "Task_organizationId_assigneeId_status_idx" ON "Task"("organizationId", "assigneeId", "status");
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_organizationId_fkey"
    FOREIGN KEY ("projectId", "organizationId") REFERENCES "Project"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_organizationId_fkey"
    FOREIGN KEY ("createdById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_organizationId_fkey"
    FOREIGN KEY ("assigneeId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProjectComment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectComment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProjectComment_organizationId_projectId_createdAt_idx" ON "ProjectComment"("organizationId", "projectId", "createdAt");
CREATE INDEX "ProjectComment_organizationId_taskId_createdAt_idx" ON "ProjectComment"("organizationId", "taskId", "createdAt");
ALTER TABLE "ProjectComment" ADD CONSTRAINT "ProjectComment_projectId_organizationId_fkey"
    FOREIGN KEY ("projectId", "organizationId") REFERENCES "Project"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectComment" ADD CONSTRAINT "ProjectComment_taskId_projectId_organizationId_fkey"
    FOREIGN KEY ("taskId", "projectId", "organizationId") REFERENCES "Task"("id", "projectId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectComment" ADD CONSTRAINT "ProjectComment_authorId_organizationId_fkey"
    FOREIGN KEY ("authorId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProjectDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "uploaderId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectDocument_organizationId_storageKey_key" ON "ProjectDocument"("organizationId", "storageKey");
CREATE INDEX "ProjectDocument_organizationId_projectId_createdAt_idx" ON "ProjectDocument"("organizationId", "projectId", "createdAt");
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_projectId_organizationId_fkey"
    FOREIGN KEY ("projectId", "organizationId") REFERENCES "Project"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_taskId_projectId_organizationId_fkey"
    FOREIGN KEY ("taskId", "projectId", "organizationId") REFERENCES "Task"("id", "projectId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_uploaderId_organizationId_fkey"
    FOREIGN KEY ("uploaderId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_organizationId_recipientId_readAt_createdAt_idx"
    ON "Notification"("organizationId", "recipientId", "readAt", "createdAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_organizationId_fkey"
    FOREIGN KEY ("recipientId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_organizationId_fkey"
    FOREIGN KEY ("actorId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
