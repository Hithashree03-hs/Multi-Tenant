import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../auth/AuthContext.jsx";
import { ProtectedRoute } from "../auth/ProtectedRoute.jsx";
import { AttendancePage, CourseDetailPage, CoursesPage, DepartmentsPage, NotificationsPage, OrganizationPage, ProjectDetailPage, UsersPage } from "./WorkspacePages.jsx";

vi.mock("../auth/AuthContext.jsx", () => ({ useAuth: vi.fn() }));

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function list(data = [], extra = {}) {
  return { success: true, data, pagination: { page: 1, limit: 100, total: data.length, totalPages: data.length ? 1 : 0 }, ...extra };
}

function renderRoute(path, routePath, element) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path={routePath} element={element} /></Routes></MemoryRouter>);
}

function renderGatedRoute(path, roles, element) {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route element={<ProtectedRoute allowedRoles={roles} />}><Route path={path} element={element} /></Route>
    <Route path="/" element={<h1>Workspace dashboard</h1>} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  useAuth.mockReturnValue({ user: { id: "student-1", role: "STUDENT", name: "Asha Student" }, token: "test-token" });
});

describe("workspace page API workflows", () => {
  it("updates only edited organization fields and renders the saved response", async () => {
    const user = userEvent.setup();
    useAuth.mockReturnValue({ user: { id: "admin-1", role: "ADMIN", name: "Campus Admin", organizationId: "org-1" }, token: "test-token" });
    const organization = { id: "org-1", name: "Old Academy", slug: "old-academy", createdAt: "2026-01-01T00:00:00.000Z" };
    const updates = [];
    const fetchMock = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname.replace("/api", "");
      if (path === "/organizations/org-1" && init.method === "GET") return response({ success: true, data: organization });
      if (path === "/organizations/org-1" && init.method === "PATCH") {
        const body = JSON.parse(init.body);
        updates.push({ path, body, headers: init.headers });
        Object.assign(organization, body);
        return response({ success: true, data: { ...organization } });
      }
      throw new Error(`Unexpected request: ${init.method || "GET"} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRoute("/organization", "/organization", <OrganizationPage />);

    await user.click(await screen.findByRole("button", { name: "Edit organization" }));
    await user.clear(screen.getByLabelText("Organization name"));
    await user.type(screen.getByLabelText("Organization name"), "New Academy");
    await user.click(screen.getByRole("button", { name: "Save organization" }));
    await waitFor(() => expect(document.querySelector(".organization-card")?.textContent).toContain("New Academy"));
    expect(document.querySelector(".organization-card")?.textContent).toContain("old-academy");

    await user.click(screen.getByRole("button", { name: "Edit organization" }));
    await user.clear(screen.getByLabelText(/Organization slug/));
    await user.type(screen.getByLabelText(/Organization slug/), "new-academy");
    await user.click(screen.getByRole("button", { name: "Save organization" }));
    await waitFor(() => expect(document.querySelector(".organization-card")?.textContent).toContain("new-academy"));
    expect(document.querySelector(".organization-card")?.textContent).toContain("New Academy");
    expect(updates).toEqual([
      { path: "/organizations/org-1", body: { name: "New Academy" }, headers: expect.objectContaining({ Authorization: "Bearer test-token", "Content-Type": "application/json" }) },
      { path: "/organizations/org-1", body: { slug: "new-academy" }, headers: expect.objectContaining({ Authorization: "Bearer test-token", "Content-Type": "application/json" }) },
    ]);
    expect(updates.every(({ headers }) => !("x-platform-admin-key" in headers))).toBe(true);
  });

  it("keeps the edit form open and shows a useful API error when the slug conflicts", async () => {
    const user = userEvent.setup();
    useAuth.mockReturnValue({ user: { id: "admin-1", role: "ADMIN", name: "Campus Admin", organizationId: "org-1" }, token: "test-token" });
    const organization = { id: "org-1", name: "Old Academy", slug: "old-academy" };
    const fetchMock = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname.replace("/api", "");
      if (path === "/organizations/org-1" && init.method === "GET") return response({ success: true, data: organization });
      if (path === "/organizations/org-1" && init.method === "PATCH") {
        return response({ success: false, message: "An organization with this slug already exists" }, 409);
      }
      throw new Error(`Unexpected request: ${init.method || "GET"} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRoute("/organization", "/organization", <OrganizationPage />);

    await user.click(await screen.findByRole("button", { name: "Edit organization" }));
    await user.clear(screen.getByLabelText(/Organization slug/));
    await user.type(screen.getByLabelText(/Organization slug/), "taken-slug");
    await user.click(screen.getByRole("button", { name: "Save organization" }));
    expect((await screen.findByRole("alert")).textContent).toContain("An organization with this slug already exists");
    expect(screen.getByRole("button", { name: "Save organization" })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("opens Add organization UI but never sends tenant credentials or a creation request", async () => {
    const user = userEvent.setup();
    useAuth.mockReturnValue({ user: { id: "admin-1", role: "ADMIN", name: "Campus Admin", organizationId: "org-1" }, token: "test-token" });
    const organization = { id: "org-1", name: "Old Academy", slug: "old-academy" };
    const fetchMock = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname.replace("/api", "");
      if (path === "/organizations/org-1" && init.method === "GET") return response({ success: true, data: organization });
      throw new Error(`Unexpected request: ${init.method || "GET"} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRoute("/organization", "/organization", <OrganizationPage />);

    await user.click(await screen.findByRole("button", { name: "+ Add organization" }));
    expect(screen.getByRole("heading", { name: "Add organization" })).toBeTruthy();
    expect(screen.getByLabelText("Organization name").required).toBe(true);
    expect(screen.getByLabelText(/Organization slug/).required).toBe(true);
    expect(screen.getByLabelText(/Organization slug/).pattern).toBe("[a-z0-9]+(?:-[a-z0-9]+)*");
    expect(screen.getByText(/requires trusted platform administrator authorization/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create organization" }).disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(fetchMock.mock.calls.every(([, init]) => !("x-platform-admin-key" in init.headers))).toBe(true);
  });

  it("edits the selected course by ID, preserves untouched values, and reloads persisted data", async () => {
    const user = userEvent.setup();
    useAuth.mockReturnValue({ user: { id: "admin-1", role: "ADMIN", name: "Campus Admin" }, token: "test-token" });
    const course = {
      id: "course-7", code: "BIO-101", title: "Biology", description: "Foundations", capacity: 40,
      status: "PUBLISHED", departmentId: "dept-3", facultyId: "faculty-5", organizationId: "org-1",
    };
    const updates = [];
    const fetchMock = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname.replace("/api", "");
      if (path === "/courses" && (!init.method || init.method === "GET")) return response(list([{ ...course }]));
      if (path === "/departments") return response(list([{ id: "dept-3", name: "Biology", code: "BIO" }]));
      if (path === "/users") return response(list([{ id: "faculty-5", name: "Faculty Member", role: "FACULTY" }]));
      if (path === "/courses/course-7" && init.method === "PATCH") {
        const body = JSON.parse(init.body);
        updates.push({ path, body });
        Object.assign(course, body);
        return response({ success: true, data: { ...course } });
      }
      throw new Error(`Unexpected request: ${init.method || "GET"} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = renderRoute("/courses", "/courses", <CoursesPage />);

    await user.click(await screen.findByRole("button", { name: "Edit course" }));
    await user.clear(screen.getByLabelText("Course title"));
    await user.type(screen.getByLabelText("Course title"), "Cell Biology");
    await user.click(screen.getByRole("button", { name: "Save course" }));
    expect(await screen.findByRole("heading", { name: "Cell Biology" })).toBeTruthy();
    expect(screen.getByText("BIO-101")).toBeTruthy();
    expect(screen.getByText("Foundations")).toBeTruthy();
    expect(document.querySelector(".course-card-meta")?.textContent).toContain("40 seats");
    expect(updates).toEqual([{ path: "/courses/course-7", body: { title: "Cell Biology" } }]);

    view.unmount();
    renderRoute("/courses", "/courses", <CoursesPage />);
    expect(await screen.findByRole("heading", { name: "Cell Biology" })).toBeTruthy();
    expect(course).toMatchObject({ code: "BIO-101", description: "Foundations", capacity: 40, departmentId: "dept-3", facultyId: "faculty-5", status: "PUBLISHED" });
  });

  it("keeps the faculty people page read-only", async () => {
    useAuth.mockReturnValue({ user: { id: "faculty-1", role: "FACULTY", name: "Faculty Member" }, token: "test-token" });
    const student = { id: "student-1", name: "Asha Student", email: "asha@example.edu", role: "STUDENT" };
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (new URL(url).pathname.includes("/users")) return response(list([student]));
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderRoute("/users", "/users", <UsersPage />);

    expect(await screen.findByText("Asha Student")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add person/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit", exact: true })).toBeNull();
  });

  it("redirects students away from people routes and faculty away from student enrollments", async () => {
    useAuth.mockReturnValue({ isAuthenticated: true, isInitializing: false, user: { role: "STUDENT" } });
    const student = renderGatedRoute("/users", ["ADMIN", "FACULTY"], <h1>People directory</h1>);
    expect(await screen.findByRole("heading", { name: "Workspace dashboard" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "People directory" })).toBeNull();
    student.unmount();

    useAuth.mockReturnValue({ isAuthenticated: true, isInitializing: false, user: { role: "FACULTY" } });
    renderGatedRoute("/enrollments", ["STUDENT"], <h1>My enrollments</h1>);
    expect(await screen.findByRole("heading", { name: "Workspace dashboard" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "My enrollments" })).toBeNull();
  });

  it("lets faculty view an assigned roster without enrollment removal controls", async () => {
    useAuth.mockReturnValue({ user: { id: "faculty-1", role: "FACULTY", name: "Faculty Member" }, token: "test-token" });
    const course = { id: "course-1", code: "BIO-101", title: "Biology", organizationId: "org-1", facultyId: "faculty-1", departmentId: "dept-1", status: "PUBLISHED" };
    const student = { id: "student-1", name: "Asha Student", email: "asha@example.edu", role: "STUDENT" };
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const path = new URL(url).pathname.replace("/api", "");
      if (path === "/courses/course-1") return response({ success: true, data: course });
      if (path === "/departments") return response(list([{ id: "dept-1", name: "Biology", code: "BIO" }]));
      if (path === "/courses/course-1/enrollments") return response(list([{ id: "enrollment-1", studentId: student.id, student }]));
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderRoute("/courses/course-1", "/courses/:id", <CourseDetailPage />);
    expect(await screen.findByText("Asha Student")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove", exact: true })).toBeNull();
  });

  it("shows loading, then a clear empty state for departments", async () => {
    let finishRequest;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { finishRequest = resolve; })));
    renderRoute("/departments", "/departments", <DepartmentsPage />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    finishRequest(response(list()));
    expect(await screen.findByText("No departments yet")).toBeTruthy();
  });

  it("shows network failures instead of silently hiding them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderRoute("/departments", "/departments", <DepartmentsPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot reach the CampusFlow API");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("enrolls a student and reloads the enrollment state", async () => {
    const user = userEvent.setup();
    let enrollments = [];
    const course = { id: "course-1", code: "BIO-101", title: "Biology", description: "Foundations", status: "PUBLISHED", capacity: 40, departmentId: "dept-1", createdAt: "2026-01-01T00:00:00.000Z" };
    const fetchMock = vi.fn(async (url, init = {}) => {
      const { pathname } = new URL(url);
      const path = pathname.replace("/api", "");
      if (path === "/courses/course-1") return response({ success: true, data: course });
      if (path === "/departments") return response(list([{ id: "dept-1", name: "Science", code: "SCI" }]));
      if (path === "/enrollments/me") return response(list(enrollments));
      if (path === "/courses/course-1/enroll" && init.method === "POST") {
        enrollments = [{ id: "enrollment-1", courseId: "course-1", enrolledAt: "2026-10-19T00:00:00.000Z" }];
        return response({ success: true, data: enrollments[0] }, 201);
      }
      throw new Error(`Unexpected request: ${init.method || "GET"} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRoute("/courses/course-1", "/courses/:id", <CourseDetailPage />);

    await user.click(await screen.findByRole("button", { name: "Enroll in course" }));
    expect(await screen.findByText(/enrolled since/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/courses/course-1/enroll"), expect.objectContaining({ method: "POST" }));
  });

  it("edits task details and priority, then applies a valid task status update", async () => {
    const user = userEvent.setup();
    useAuth.mockReturnValue({ user: { id: "owner-1", role: "ADMIN", name: "Campus Admin" }, token: "test-token" });
    const project = { id: "project-1", ownerId: "owner-1", title: "Campus research", status: "ACTIVE", startsAt: null, dueAt: null, updatedAt: "2026-10-19T00:00:00.000Z" };
    const members = [{ id: "member-1", userId: "owner-1", user: { name: "Campus Admin", role: "ADMIN", email: "admin@example.edu" } }];
    const tasks = [{ id: "task-1", projectId: "project-1", createdById: "owner-1", assigneeId: null, title: "Research outline", description: "First draft", status: "TODO", priority: "NORMAL", dueAt: null }];
    const mutations = [];
    const fetchMock = vi.fn(async (url, init = {}) => {
      const { pathname } = new URL(url);
      const path = pathname.replace("/api", "");
      if (init.method === "PATCH") {
        const body = JSON.parse(init.body);
        mutations.push({ path, body });
        Object.assign(tasks[0], body);
        return response({ success: true, data: tasks[0] });
      }
      if (path === "/projects/project-1") return response({ success: true, data: project });
      if (path === "/projects/project-1/members") return response(list(members));
      if (path === "/projects/project-1/tasks") return response(list(tasks));
      if (path === "/projects/project-1/comments" || path === "/projects/project-1/documents") return response(list());
      throw new Error(`Unexpected request: ${init.method || "GET"} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRoute("/projects/project-1", "/projects/:id", <ProjectDetailPage />);

    await user.click(await screen.findByRole("button", { name: "Edit", exact: true }));
    await user.clear(screen.getByLabelText("Task title"));
    await user.type(screen.getByLabelText("Task title"), "Updated research outline");
    await user.selectOptions(screen.getByLabelText("Priority"), "HIGH");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mutations[0]).toEqual({
      path: "/projects/project-1/tasks/task-1",
      body: { title: "Updated research outline", description: "First draft", priority: "HIGH", dueAt: null, assigneeId: null },
    }));

    await user.selectOptions(await screen.findByLabelText("Task status for Updated research outline"), "IN_PROGRESS");
    await waitFor(() => expect(mutations[1]).toEqual({ path: "/projects/project-1/tasks/task-1", body: { status: "IN_PROGRESS" } }));
  });

  it("updates an existing attendance record and refreshes its course summary", async () => {
    const user = userEvent.setup();
    useAuth.mockReturnValue({ user: { id: "admin-1", role: "ADMIN", name: "Campus Admin" }, token: "test-token" });
    const course = { id: "course-1", code: "BIO-101", title: "Biology" };
    const session = { id: "session-1", courseId: course.id, title: "Week one", startsAt: "2026-10-01T10:00:00.000Z" };
    const student = { id: "student-1", name: "Asha Student", email: "asha@example.edu", role: "STUDENT" };
    const records = [{
      id: "attendance-1", sessionId: session.id, courseId: course.id, enrollmentId: "enrollment-1", status: "PRESENT",
      markedAt: "2026-10-01T10:00:00.000Z", enrollment: { student },
    }];
    const bodyCalls = [];
    const attendanceReport = () => ({
      course,
      totals: Object.fromEntries(["PRESENT", "ABSENT", "LATE", "EXCUSED"].map((status) => [status, records.filter((record) => record.status === status).length])),
      total: records.length,
    });
    const fetchMock = vi.fn(async (url, init = {}) => {
      const { pathname } = new URL(url);
      const path = pathname.replace("/api", "");
      if (path === "/courses") return response(list([course]));
      if (path === "/attendance/sessions") return response(list([session]));
      if (path === "/attendance/sessions/session-1/records") {
        if (init.method === "POST") {
          const body = JSON.parse(init.body);
          bodyCalls.push(body);
          Object.assign(records[0], { status: body.status, markedAt: "2026-10-02T10:00:00.000Z" });
          return response({ success: true, created: false, data: { id: records[0].id, sessionId: session.id, courseId: course.id, enrollmentId: "enrollment-1", status: records[0].status, markedAt: records[0].markedAt } });
        }
        return response(list(records));
      }
      if (path === "/courses/course-1/enrollments") return response(list([{ studentId: student.id, student }]));
      if (path === "/attendance/reports/course/course-1") return response({ success: true, data: attendanceReport() });
      throw new Error(`Unexpected request: ${init.method || "GET"} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRoute("/attendance", "/attendance", <AttendancePage />);

    await waitFor(() => expect(document.querySelector("#report-course")).toBeTruthy());
    const statusForm = document.querySelector("#attendance-status");
    const recordButton = screen.getByRole("button", { name: "Record attendance" });
    expect(statusForm.value).toBe("");
    expect(statusForm.required).toBe(true);
    expect(recordButton.disabled).toBe(true);
    expect(screen.getByLabelText("Attendance status for Asha Student").value).toBe("PRESENT");
    await user.selectOptions(document.querySelector("#attendance-student"), student.id);
    expect(recordButton.disabled).toBe(true);
    await user.selectOptions(document.querySelector("#report-course"), course.id);
    await user.click(await screen.findByRole("button", { name: "Show report" }));
    await waitFor(() => expect(document.querySelector(".report-values")?.textContent).toContain("PRESENT"));

    for (const status of ["LATE", "ABSENT", "EXCUSED"]) {
      await user.selectOptions(document.querySelector("#attendance-student"), student.id);
      await user.selectOptions(document.querySelector("#attendance-status"), status);
      await user.click(screen.getByRole("button", { name: "Record attendance" }));
      await waitFor(() => expect(screen.getByLabelText("Attendance status for Asha Student").value).toBe(status));
      await waitFor(() => {
        expect(statusForm.value).toBe("");
        expect(recordButton.disabled).toBe(true);
      });
      await waitFor(() => {
        const values = [...document.querySelectorAll(".report-values > div:not(.report-total)")];
        expect(Object.fromEntries(values.map((row) => [row.querySelector(".badge").textContent, Number(row.querySelector("strong").textContent)]))).toEqual({
          PRESENT: 0, ABSENT: status === "ABSENT" ? 1 : 0, LATE: status === "LATE" ? 1 : 0, EXCUSED: status === "EXCUSED" ? 1 : 0,
        });
      });
      expect(records).toHaveLength(1);
    }
    expect(bodyCalls.map((body) => body.status)).toEqual(["LATE", "ABSENT", "EXCUSED"]);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/attendance/reports/course/course-1"))).toHaveLength(4);
  });

  it("marks an unread notification as read and refreshes the list", async () => {
    const user = userEvent.setup();
    const item = { id: "notification-1", title: "Task assigned", message: "A task is waiting", type: "TASK_ASSIGNED", readAt: null, createdAt: "2026-10-19T00:00:00.000Z", actor: { name: "Faculty Member" } };
    const fetchMock = vi.fn(async (url, init = {}) => {
      const { pathname } = new URL(url);
      const path = pathname.replace("/api", "");
      if (path === "/notifications" && init.method === "PATCH") {
        item.readAt = "2026-10-19T01:00:00.000Z";
        return response({ success: true, message: "Notification marked as read" });
      }
      if (path === "/notifications/notification-1/read") {
        item.readAt = "2026-10-19T01:00:00.000Z";
        return response({ success: true, message: "Notification marked as read" });
      }
      if (path === "/notifications") return response(list([item], { unreadCount: item.readAt ? 0 : 1 }));
      throw new Error(`Unexpected request: ${init.method || "GET"} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRoute("/notifications", "/notifications", <NotificationsPage />);

    await user.click(await screen.findByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(document.querySelector(".notification-read")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Mark read" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/notifications/notification-1/read"), expect.objectContaining({ method: "PATCH" }));
  });
});
