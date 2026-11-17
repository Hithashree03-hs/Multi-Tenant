# CampusFlow Pro Backend

CampusFlow Pro is a multi-organization campus-management and student project-management service. The backend provides registration and login, organization and department management, tenant-scoped users, courses and enrollment, attendance, project collaboration, in-app notifications, and role-scoped dashboard summaries.

## Architecture and request flow

- Node.js and Express expose JSON REST APIs.
- Prisma 7 uses the existing PostgreSQL adapter in `src/prisma.js`.
- Authentication issues one-hour HS256 JWTs. Passwords are hashed with bcrypt before storage.
- Registration and login share a configurable per-IP rate limit (20 requests per 15 minutes by default).
- Protected requests verify the JWT, then resolve the user by both ID and organization ID from PostgreSQL. Current database role and organization membership replace the token's possibly stale role claims.
- Department queries always filter by the organization from that database-backed request context. Request parameters and bodies cannot choose a tenant.
- User administration, courses, and enrollments also filter on the authenticated tenant. PostgreSQL composite foreign keys prevent courses from linking to another organization's department or faculty member, and prevent enrollment in a course outside the student's organization.
- Enrollment checks the course capacity inside a serializable database transaction. Unique constraints prevent duplicate enrollments.
- Attendance sessions, records, projects, project members, tasks, comments, document metadata, and notifications use authenticated tenant context and additional PostgreSQL composite foreign keys to prevent cross-organization relationships.
- Project access is limited to tenant administrators, project owners, and members. Faculty attendance operations are limited to courses assigned to that faculty member. Students can see only their own attendance.
- Notification recipients can list and mark only their own notifications. Dashboard queries aggregate records in the authenticated organization and apply role-specific ownership filters.
- Platform organization management uses a separate server-side credential. An organization ADMIN is an administrator inside one organization, not a platform administrator.

The React frontend lives in `../frontend`. Do not put `PLATFORM_ADMIN_SECRET` in frontend code or send it from a browser application.

## Technology

- Node.js, Express 5, and CommonJS JavaScript
- PostgreSQL and Prisma 7 with `@prisma/adapter-pg`
- bcrypt 6 and jsonwebtoken 9
- Node's built-in test runner

## Prerequisites and installation

Install Node.js and PostgreSQL, then run these commands from `backend`:

```powershell
npm install
Copy-Item .env.example .env
```

If `.env` already exists, keep it and update the required variables manually; do not overwrite existing credentials. Create the `campusflow` PostgreSQL database if it does not already exist. Example local setup command:

```powershell
createdb campusflow
```

Set these variables in `.env`:

| Variable | Purpose |
| --- | --- |
| `PORT` | Express listening port; defaults to `5000`. |
| `DATABASE_URL` | PostgreSQL connection string for the existing database. |
| `JWT_SECRET` | HS256 signing secret; the backend requires at least 32 UTF-8 bytes. |
| `DEFAULT_ORGANIZATION_ID` | Existing organization ID assigned to new student accounts. |
| `PLATFORM_ADMIN_SECRET` | Separate secret of at least 32 bytes for platform-level organization management. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | Rate-limit window in milliseconds; defaults to `900000`. |
| `AUTH_RATE_LIMIT_MAX` | Maximum registration and login requests from one IP in that window; defaults to `20`. |
| `FRONTEND_ORIGINS` | Comma-separated exact browser origins allowed by CORS; local Vite origins are the default. |

Use the hidden PowerShell prompt in the repository's root `README.md` to provide both secrets to the current terminal process without printing them or editing an existing `.env` file. The two secrets must be different. Start the backend from that same terminal so it inherits the values. Rotating `JWT_SECRET` invalidates all previously issued bearer tokens because their signatures will no longer verify.

### One-time initial tenant administrator bootstrap

The public registration route creates STUDENT accounts only. To provision the first `ADMIN` for an existing organization, use the backend-only CLI below. It creates no HTTP endpoint, does not use `PLATFORM_ADMIN_SECRET`, and refuses to run if an ADMIN already exists in the requested organization. A PostgreSQL transaction-scoped advisory lock serializes concurrent attempts for that organization. The database's global email uniqueness constraint also prevents duplicate addresses across organizations.

Run this from a fresh PowerShell terminal in the backend directory. The organization ID, name, and email are prompted locally. The password prompt is hidden; the values are held only in that terminal process for this invocation, are cleared afterward, and are never written to `.env` or printed by the command. Use a unique email not already present anywhere in the database.

```powershell
Set-Location 'C:\Users\hitha\Desktop\Campusflow pro\backend'
$secureBootstrapPassword = $null
$bootstrapPasswordPointer = [IntPtr]::Zero
try {
    $env:BOOTSTRAP_ORGANIZATION_ID = Read-Host 'Existing organization ID'
    $env:BOOTSTRAP_ADMIN_NAME = Read-Host 'Administrator name'
    $env:BOOTSTRAP_ADMIN_EMAIL = Read-Host 'Administrator email'
    $secureBootstrapPassword = Read-Host 'Initial administrator password' -AsSecureString
    $bootstrapPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureBootstrapPassword)
    $env:BOOTSTRAP_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bootstrapPasswordPointer)

    npm run bootstrap:admin
    if ($LASTEXITCODE -ne 0) { throw 'Administrator bootstrap did not complete.' }
}
finally {
    if ($bootstrapPasswordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bootstrapPasswordPointer)
    }
    if ($secureBootstrapPassword) { $secureBootstrapPassword.Dispose() }
    Remove-Item Env:BOOTSTRAP_ORGANIZATION_ID, Env:BOOTSTRAP_ADMIN_NAME, Env:BOOTSTRAP_ADMIN_EMAIL, Env:BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
}
```

The command validates the existing organization, normalized email, name, and the same password length limits as registration. It hashes the password with the same bcrypt cost used by registration. Success prints only a generic confirmation. A missing organization, duplicate email, or existing administrator produces a safe explanation without printing submitted values or database details. It does not change any existing user. Run the command again only for a different organization that still has no ADMIN.

Verify `DEFAULT_ORGANIZATION_ID` against the existing organization using a trusted PostgreSQL console. This read-only query returns organization identifiers and names; do not share connection credentials or output containing private organization information:

```sql
SELECT "id", "name", "slug" FROM "Organization" WHERE "slug" = 'global-academy';
```

## Database setup and migrations

All prior migrations are retained. The department, course/enrollment, and core modules migrations are additive. The latest migration adds attendance, project collaboration, document metadata, and in-app notification tables, composite tenant foreign keys, uniqueness constraints, and lookup indexes. It does not rewrite or delete existing user or organization rows.

```powershell
npm run db:generate
npm run db:status
npm run db:migrate
```

`db:migrate` uses Prisma's deploy command to apply checked-in migrations. Do not use database-reset commands against the existing database. Confirm the migration status before and after applying migrations.

## Development and tests

```powershell
npm run dev
npm test
```

The default automated tests use mock Prisma clients and local HTTP servers:

```powershell
npm test
```

The PostgreSQL integration tests use uniquely generated test records, verify HTTP-level authorization and tenant isolation against real PostgreSQL queries, and remove only records created by each test. They are guarded: every integration-test entrypoint refuses to connect unless the database name parsed from `DATABASE_URL` is exactly `campusflow_test`. The guard does not print the connection string.

Never run the integration suite against the development `campusflow` database. If the dedicated database does not exist, first confirm you are connected to the intended PostgreSQL server and check whether it already exists:

```sql
SELECT datname FROM pg_database WHERE datname = 'campusflow_test';
```

If it is absent, create the empty `campusflow_test` database using a trusted PostgreSQL administration tool. Do not drop or reset an existing database. Make a `CAMPUSFLOW_TEST_DATABASE_URL` environment variable available to the current PowerShell session through your local secret manager or shell configuration; it must point to that database. The commands below temporarily override `DATABASE_URL` for this PowerShell process only, verify the database name, apply pending migrations to the dedicated test database, and restore the prior process value. They do not edit `.env`.

```powershell
$previousDatabaseUrl = $env:DATABASE_URL
try {
    if (-not $env:CAMPUSFLOW_TEST_DATABASE_URL) {
        throw 'Set CAMPUSFLOW_TEST_DATABASE_URL to the dedicated test database first.'
    }
    $env:DATABASE_URL = $env:CAMPUSFLOW_TEST_DATABASE_URL
    $databaseName = [Uri]::UnescapeDataString(([Uri]$env:DATABASE_URL).AbsolutePath.TrimStart('/').Split('/')[0])
    if ($databaseName -ne 'campusflow_test') {
        throw 'Refusing to continue: DATABASE_URL must target campusflow_test.'
    }

    npm run db:status
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the test database migration status.' }
    npm run db:migrate
    if ($LASTEXITCODE -ne 0) { throw 'Could not apply migrations to the test database.' }
    npm run test:integration
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL integration tests failed.' }
}
finally {
    if ($null -eq $previousDatabaseUrl) {
        Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    } else {
        $env:DATABASE_URL = $previousDatabaseUrl
    }
}
The integration command requires PostgreSQL and Prisma's generated client. Tests run sequentially; interrupted runs may leave uniquely identified temporary rows in `campusflow_test`, so inspect or recreate only that dedicated test database using your normal test-environment process.

The authentication limiter uses an in-memory store for this single-process development setup. A multi-process deployment needs a shared rate-limit store, and a reverse proxy must be configured deliberately before trusting forwarded client IP headers.

## Frontend and browser access

The React/Vite browser application is in `../frontend`. Its setup and run commands are in `../frontend/README.md`. The backend allows the local Vite origins by default. Set `FRONTEND_ORIGINS` to a comma-separated list of exact trusted browser origins for deployment (for example, `https://campus.example.edu`); do not use `*` for a credentialed or authenticated application. Requests without an `Origin` header remain available for local command-line clients.

## API summary

All responses use JSON. Authentication errors use `401`, insufficient roles use `403`, validation failures use `400`, missing records use `404`, and duplicate records use `409`.

### Authentication

| Method and path | Access | Purpose |
| --- | --- | --- |
| `POST /api/auth/register` | Public, configured tenant only | Creates a STUDENT account in `DEFAULT_ORGANIZATION_ID`. The request accepts `name`, `email`, and `password`; clients cannot choose role or organization. |
| `POST /api/auth/login` | Public | Checks the bcrypt password hash and returns the bearer token and safe profile. |
| `GET /api/auth/me` | Any authenticated user | Returns the current database-backed profile for the token's user and organization. |

Example registration body:

```json
{
  "name": "Example Student",
  "email": "student@example.edu",
  "password": "replace-this-with-a-long-password"
}
```

Example login body:

```json
{
  "email": "student@example.edu",
  "password": "replace-this-with-a-long-password"
}
```

Use the returned bearer token in an `Authorization: Bearer <token>` header for authenticated routes. Keep it private. The login response is the only API response that returns a JWT.

### Organizations

Tenant administrators can update their own organization's name and slug. Faculty and students can view their current organization's safe profile but cannot change it. Platform-level create/list-all/retrieve-any/update/delete operations use the `x-platform-admin-key` header and `PLATFORM_ADMIN_SECRET`. This credential is for trusted server administration only; do not expose it to a browser or log it.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /api/organizations` | Authenticated tenant user, or platform key | Tenant users receive only their own organization in the existing `data` array shape. The platform key can list all organizations. |
| `GET /api/organizations/:id` | Authenticated member of that organization, or platform key | A tenant user cannot retrieve another organization's record. |
| `POST /api/organizations` | Platform key | Creates an organization from `name` and `slug`. |
| `PATCH /api/organizations/:id` | ADMIN for their own organization, or platform key | Updates `name` and/or `slug`; a tenant ADMIN cannot update another organization. |
| `DELETE /api/organizations/:id` | Platform key | Deletes an organization only if no related records prevent deletion. |

Example trusted platform request (replace the placeholder locally; never commit the real value):

```powershell
Invoke-RestMethod -Method Post http://localhost:5000/api/organizations `
  -Headers @{ 'x-platform-admin-key' = '<PLATFORM_ADMIN_SECRET>' } `
  -ContentType 'application/json' `
  -Body '{"name":"Example Academy","slug":"example-academy"}'
```

Organization creation and deletion require a platform credential. Platform operations fail closed if that credential is missing or shorter than 32 bytes. Existing organizations with users cannot be deleted because the database foreign key uses `RESTRICT`.

### Departments

All paths require a valid JWT whose user still exists in the same organization in PostgreSQL. ADMIN can create, update, and delete departments; ADMIN, FACULTY, and STUDENT can list and retrieve departments in their own organization.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /api/departments?page=1&limit=20` | Any authenticated role | Paginated list scoped to the current organization. `limit` is 1–100. |
| `GET /api/departments/:id` | Any authenticated role | Retrieves a department only inside the current organization. |
| `POST /api/departments` | ADMIN | Creates a department with `name` and `code`; organization is assigned by the server. |
| `PATCH /api/departments/:id` | ADMIN | Updates `name` and/or `code` inside the current organization. |
| `DELETE /api/departments/:id` | ADMIN | Deletes a department inside the current organization. |

Department codes are normalized to uppercase and unique within an organization. Clients cannot supply an organization ID as authorization proof.

### Users

All paths require authentication and use the organization attached by the database-backed JWT middleware. The `password` field is accepted only on create or administrator password reset, hashed with bcrypt, and never returned. Tenant administrators may create FACULTY and STUDENT accounts and manage non-administrator accounts. Faculty may read their own tenant's student directory and student profiles, but cannot create or change accounts. No tenant route can create or promote an ADMIN. There is no hard-delete endpoint for user records.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /api/users?page=1&limit=20` | ADMIN, FACULTY | Paginated tenant user directory; faculty see students only. |
| `GET /api/users/:id` | ADMIN, FACULTY | Retrieves a user in the current tenant; faculty can retrieve students only. |
| `POST /api/users` | ADMIN | Creates a tenant user; role defaults to STUDENT and may be FACULTY or STUDENT. |
| `PATCH /api/users/:id` | ADMIN | Updates non-administrator name, email, role, or password. Role can be FACULTY or STUDENT only. |

Example administrator-created student body:

```json
{
  "name": "Example Student",
  "email": "student@example.edu",
  "password": "replace-this-with-a-long-password",
  "role": "STUDENT"
}
```

The backend takes `organizationId` from the administrator's authenticated account. Do not include it in the request.
An administrator must reassign a faculty member's courses before changing that account to STUDENT.

### Courses and enrollment

All course records are tenant-scoped. ADMIN can manage all courses and enrollments in the tenant. FACULTY can manage permitted details for courses assigned to themselves and view their rosters, but cannot add or remove enrollments. STUDENT can browse published courses in their tenant and manage only their own enrollment. A course requires a department in the same tenant. Only FACULTY users from the same tenant may be assigned. Faculty-created courses are assigned to the requesting faculty member automatically. Course capacity is between 1 and 10,000, and cannot be lowered below the current enrollment count.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /api/courses?page=1&limit=20` | Any authenticated user | Paginated tenant catalog. Students see published courses; faculty see assigned courses; administrators see all tenant courses. |
| `GET /api/courses/:id` | Any authenticated user | Retrieves a course only if visible under the role rules above. |
| `POST /api/courses` | ADMIN, FACULTY | Creates a course. The organization always comes from the authenticated user. |
| `PATCH /api/courses/:id` | ADMIN, assigned FACULTY | Updates a course; faculty cannot reassign or archive courses. |
| `DELETE /api/courses/:id` | ADMIN | Deletes a course only if it has no enrollments. |
| `GET /api/courses/:id/enrollments?page=1&limit=20` | ADMIN, assigned FACULTY | Paginated course roster with safe student profiles. |
| `POST /api/courses/:id/enroll` | STUDENT | Enrolls the current student in a published course in their tenant. |
| `DELETE /api/courses/:id/enroll` | STUDENT | Cancels the current student's enrollment. |
| `DELETE /api/courses/:courseId/enrollments/:studentId` | ADMIN | Removes a student from a course in the current tenant. |
| `GET /api/enrollments/me?page=1&limit=20` | STUDENT | Lists the current student's enrollments and safe course details. |

Example course body:

```json
{
  "code": "CS-101",
  "title": "Introduction to Computer Science",
  "description": "A sample course description",
  "departmentId": "<department-id>",
  "facultyId": "<faculty-user-id>",
  "capacity": 40,
  "status": "PUBLISHED"
}
```

`facultyId` is optional for administrators. For faculty requests, the server assigns the authenticated faculty account. Do not send `organizationId`.

## Roles and tenant boundaries

- `ADMIN` is tenant-scoped. It grants user, department, course, and enrollment management only in the authenticated user's organization.
- `FACULTY` can read tenant departments and the student directory, manage permitted details for courses assigned to themselves, and run attendance for those courses. Faculty cannot administer organization settings, departments, user accounts, or enrollments.
- `STUDENT` can read tenant departments and published courses, and access only their own enrollment records.
- Tenant administrators can update their own organization's name and slug and manage users, departments, courses, and enrollments only inside that organization. They cannot create, promote, or modify ADMIN accounts.
- Only the separate platform credential can perform global organization management. The application does not pretend an organization ADMIN is a platform administrator.
- Authentication reloads role and organization membership from the database using both user ID and organization ID from a verified JWT. Removed or moved users fail authentication for old tokens.
- The organization list no longer exposes all tenants to ordinary users. It preserves the route and response shape but returns only the caller's own organization.

## Known limitations and future work

- Document content upload and download are not implemented. The API stores metadata only after a trusted storage adapter verifies an opaque object reference. No adapter is configured by default, so document metadata registration and deletion return `503` until the application is wired to private object storage.
- Departments are linked to courses, but users do not have a department membership field. Faculty are assigned directly to courses.
- Course deletion is blocked while enrollments exist. User deletion and administrator account management are intentionally not available in tenant APIs.
- User email addresses remain globally unique, not unique per organization. Changing this needs a deliberate compatibility and migration plan.
- `PLATFORM_ADMIN_SECRET` is a shared deployment credential, not a user account with audit history, revocation, or fine-grained permissions. Keep it server-side, rotate it operationally, and add access logging that never records the secret.
- Registration is restricted to the server-configured default organization and creates STUDENT accounts only.
- Password changes do not revoke already-issued JWTs before their one-hour expiry. A token version or revocation policy is needed if immediate revocation becomes a requirement.
- The new modules apply tenant filters on every route query and PostgreSQL composite keys enforce same-organization relationships. The included integration tests exercise representative tenant paths; they are not a formal proof that every production query or future access path is safe.
- The configured `JWT_SECRET` must meet the 32-byte minimum or authentication routes fail closed. Platform organization-management routes likewise fail closed when `PLATFORM_ADMIN_SECRET` is not configured.
- The browser stores JWTs in React memory only. Reloading the page ends the browser session and requires login again; a future persistent session should use a carefully designed secure, HttpOnly cookie flow.

## Attendance, projects, notifications, and dashboards

The `20261019000300_add_attendance_projects_notifications` migration adds `AttendanceSession`, `AttendanceRecord`, `Project`, `ProjectMember`, `Task`, `ProjectComment`, `ProjectDocument`, and `Notification`, plus status enums and composite tenant constraints. Run `npm run db:generate`, inspect `npm run db:status`, and apply with `npm run db:migrate`. These commands preserve the existing migrations and rows.

Every route below requires a valid bearer token. Organization scope comes from the authenticated user's current database record. `ADMIN` permissions are limited to that administrator's organization.

### Attendance endpoints

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /api/attendance/sessions?page=1&limit=20` | ADMIN, FACULTY | Lists sessions in the tenant; faculty see sessions for courses assigned to them. |
| `POST /api/attendance/sessions` | ADMIN, FACULTY | Creates a session for a tenant course; faculty must teach it. |
| `PATCH /api/attendance/sessions/:id` | ADMIN, assigned FACULTY | Changes title or dates for an accessible session. A session cannot be moved to another course. |
| `DELETE /api/attendance/sessions/:id` | ADMIN | Deletes a session only when no records reference it. |
| `GET /api/attendance/sessions/:id/records?page=1&limit=20` | ADMIN, assigned FACULTY | Lists the enrolled students' records for an accessible session. |
| `POST /api/attendance/sessions/:id/records` | ADMIN, assigned FACULTY | Creates an attendance record for an enrolled student, or updates that student's existing record for the session. It uses the unique session-and-enrollment pair; new records return `201` and updates return `200`. |
| `PATCH /api/attendance/records/:id` | ADMIN, assigned FACULTY | Updates the status of an accessible record. |
| `DELETE /api/attendance/records/:id` | ADMIN, assigned FACULTY | Deletes an accessible record. |
| `GET /api/attendance/me?page=1&limit=20` | STUDENT | Lists only the authenticated student's attendance. |
| `GET /api/attendance/reports/course/:courseId` | ADMIN, assigned FACULTY | Returns counts by attendance status for a course in the tenant. |

Dates must be ISO date-times with an explicit timezone. Valid statuses are `PRESENT`, `ABSENT`, `LATE`, and `EXCUSED`.

### Projects, members, tasks, and comments

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /api/projects?page=1&limit=20` | ADMIN, FACULTY, STUDENT | Lists tenant projects for administrators, or projects where the caller is a member/owner. |
| `POST /api/projects` | ADMIN, FACULTY, STUDENT | Creates a `PLANNING` project; the caller becomes owner and member. |
| `GET /api/projects/:id` | Tenant ADMIN, project owner/member | Retrieves a project; inaccessible and foreign-tenant projects return `404`. |
| `PATCH /api/projects/:id` | Tenant ADMIN, project owner | Updates title, description, dates, or status. Transitions are `PLANNING → ACTIVE/ARCHIVED`, `ACTIVE → COMPLETED/ARCHIVED`, `COMPLETED → ARCHIVED`; `ARCHIVED` is final. |
| `DELETE /api/projects/:id` | Tenant ADMIN, project owner | Deletes only an empty project with no tasks, comments, or documents. |
| `GET /api/projects/:id/members?page=1&limit=20` | Tenant ADMIN, project owner/member | Lists members with safe user fields. |
| `POST /api/projects/:id/members` | Tenant ADMIN, project owner | Adds a user from the same tenant; adding sends an in-app notification. |
| `DELETE /api/projects/:id/members/:userId` | Tenant ADMIN, project owner | Removes a member; the owner cannot be removed. |
| `GET /api/projects/:projectId/tasks?page=1&limit=20` | Tenant ADMIN, project owner/member | Lists tasks for an accessible project. |
| `POST /api/projects/:projectId/tasks` | Tenant ADMIN, project owner/member | Creates a task; any assignee must already be a project member. Assignments create a notification. |
| `GET /api/projects/:projectId/tasks/:taskId` | Tenant ADMIN, project owner/member | Retrieves one task in that project. |
| `PATCH /api/projects/:projectId/tasks/:taskId` | Tenant ADMIN, owner, task creator; assignee may change only status | Updates task fields subject to assignment and status rules. Status flow: `TODO → IN_PROGRESS/BLOCKED`, `IN_PROGRESS → BLOCKED/DONE`, `BLOCKED → IN_PROGRESS/DONE`; `DONE` is final. |
| `DELETE /api/projects/:projectId/tasks/:taskId` | Tenant ADMIN, project owner, task creator | Deletes a task only when comments/documents do not block it. |
| `GET /api/projects/:projectId/comments?page=1&limit=20&taskId=<id>` | Tenant ADMIN, project owner/member | Lists project or task comments. |
| `POST /api/projects/:projectId/comments` | Tenant ADMIN, project owner/member | Adds a comment as the authenticated author; the project owner receives a notification. |
| `PATCH /api/projects/:projectId/comments/:commentId` | Author, project owner, tenant ADMIN | Edits a comment. |
| `DELETE /api/projects/:projectId/comments/:commentId` | Author, project owner, tenant ADMIN | Deletes a comment. |

Project collections are paginated with limits from 1 to 100. The API does not accept author, creator, owner, organization, or membership identity as authorization proof from a request body.

### Documents

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /api/projects/:projectId/documents?page=1&limit=20` | Tenant ADMIN, project owner/member | Lists safe document metadata without returning storage references. |
| `POST /api/projects/documents` | Tenant ADMIN, project owner/member | Registers metadata only after `documentStorage.verifyObject(...)` confirms the opaque object reference. |
| `DELETE /api/projects/:projectId/documents/:documentId` | Uploader, project owner, tenant ADMIN | Deletes the private stored object through the adapter and removes its metadata. |

There is no binary upload or download endpoint. File type and 25 MB size limits are checked during metadata registration, but the actual private-storage adapter must independently verify content and enforce tenant/project scoping. To enable registration and deletion, pass a trusted adapter as `documentStorage` to `createApp(prisma, { documentStorage })`; implement `verifyObject({ organizationId, projectId, storageKey, contentType, sizeBytes })` and `deleteObject({ organizationId, projectId, storageKey })`, both returning `true` only after success. Do not use client-provided storage keys as paths and do not expose storage credentials to the browser. Without this adapter, write operations fail closed with `503`.

### Notifications and dashboards

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /api/notifications?page=1&limit=20&unread=true` | Authenticated user | Lists only the caller's notifications and includes the unread count. |
| `PATCH /api/notifications/:id/read` | Intended recipient | Marks one of the caller's notifications read. |
| `PATCH /api/notifications/read-all` | Authenticated user | Marks all of the caller's unread notifications read. |
| `GET /api/dashboard` | ADMIN, FACULTY, STUDENT | Returns real count and status aggregates scoped to the role and organization. |

ADMIN dashboards count users, faculty, students, departments, courses, enrollments, attendance records, projects, and tasks in the tenant. FACULTY dashboards count their assigned courses, related enrollments and attendance, accessible projects, and created/assigned tasks. STUDENT dashboards count their enrollments, attendance, project memberships, and assigned tasks. Each role receives project/task counts by status and the current user's unread notification count.

Example project create request:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/projects `
  -Headers @{ Authorization = "Bearer <token-from-login>" } `
  -ContentType 'application/json' `
  -Body '{"title":"Campus energy project","description":"Track usage"}'
```

Example attendance record request:

```json
{
  "studentId": "<enrolled-student-id>",
  "status": "PRESENT"
}
```

### Tests and manual verification

`npm test` runs Node's unit tests with mocked Prisma models, including the new middleware, role, tenant-filter, and attendance-upsert cases. `npm run test:integration` runs real PostgreSQL tests, creates uniquely named temporary organizations and users, and cleans up only those test records. Integration tests are not mocks; PostgreSQL must be reachable and the migrations applied first. To manually verify, register/log in or use a test user's bearer token, then try the request examples above. Also try a second tenant's project ID (expect `404`), a student calling `GET /api/attendance/sessions` (expect `403`), change an existing student's status through `POST /api/attendance/sessions/:id/records` and confirm the course report updates without increasing the record count, and try an unread notification belonging to another account (expect `404`).
