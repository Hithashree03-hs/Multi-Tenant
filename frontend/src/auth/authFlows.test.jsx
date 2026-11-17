import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./AuthContext.jsx";
import { ProtectedRoute } from "./ProtectedRoute.jsx";
import AppShell from "../components/AppShell.jsx";
import { LoginPage, RegisterPage } from "../pages/AuthPages.jsx";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function renderLoginApp(path = "/login") {
  return render(<AuthProvider><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/register" element={<RegisterPage />} />
    <Route element={<ProtectedRoute />}><Route element={<AppShell />}><Route path="/" element={<h1>Workspace dashboard</h1>} /></Route></Route>
  </Routes></MemoryRouter></AuthProvider>);
}

describe("authentication pages and session", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("marks login and registration fields required and checks email and password length", () => {
    const { unmount } = render(<AuthProvider><MemoryRouter><LoginPage /></MemoryRouter></AuthProvider>);
    expect(screen.getByLabelText("Email address").required).toBe(true);
    expect(screen.getByLabelText("Email address").type).toBe("email");
    expect(screen.getByLabelText("Password").required).toBe(true);
    unmount();

    render(<AuthProvider><MemoryRouter><RegisterPage /></MemoryRouter></AuthProvider>);
    expect(screen.getByLabelText("Full name").required).toBe(true);
    expect(screen.getByLabelText("Campus email").type).toBe("email");
    expect(screen.getByLabelText(/Password/).minLength).toBe(8);
    expect(document.querySelector("form").checkValidity()).toBe(false);
  });

  it("registers only the submitted student fields and shows the sign-in link", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(response({ success: true, data: { user: { id: "student-1", name: "Asha Student" } } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthProvider><MemoryRouter><RegisterPage /></MemoryRouter></AuthProvider>);

    await user.type(screen.getByLabelText("Full name"), "Asha Student");
    await user.type(screen.getByLabelText("Campus email"), "asha@example.edu");
    await user.type(screen.getByLabelText(/Password/), "campus-password");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText(/Your student account is ready/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in now" })).toBeTruthy();
    const registration = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(registration).toEqual({ name: "Asha Student", email: "asha@example.edu", password: "campus-password" });
    expect(fetchMock.mock.calls[0][1].body).not.toContain("organizationId");
    expect(fetchMock.mock.calls[0][1].body).not.toContain("role");
    expect(screen.getByLabelText(/Password/).value).toBe("");
  });

  it("shows server validation failures on registration", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ success: false, message: "An account with this email already exists" }, 409)));
    render(<AuthProvider><MemoryRouter><RegisterPage /></MemoryRouter></AuthProvider>);

    await user.type(screen.getByLabelText("Full name"), "Asha Student");
    await user.type(screen.getByLabelText("Campus email"), "asha@example.edu");
    await user.type(screen.getByLabelText(/Password/), "campus-password");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect((await screen.findByRole("alert")).textContent).toContain("An account with this email already exists");
  });

  it("logs in, shows navigation for the user's role, and logs out", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith("/auth/login")) return response({ success: true, data: { token: "session-token", user: { id: "student-1", name: "Asha Student", role: "STUDENT", organizationId: "org-1" } } });
      if (String(url).includes("/notifications")) return response({ success: true, data: [], unreadCount: 0 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLoginApp();

    await user.type(screen.getByLabelText("Email address"), "asha@example.edu");
    await user.type(screen.getByLabelText("Password"), "campus-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Workspace dashboard" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /My enrollments/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "People" })).toBeNull();
    expect(localStorage.length).toBe(0);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
  });

  it("shows faculty directory navigation and hides student-only links", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/auth/login")) return response({ success: true, data: { token: "faculty-token", user: { id: "faculty-1", name: "Faculty Member", role: "FACULTY", organizationId: "org-1" } } });
      if (String(url).includes("/notifications")) return response({ success: true, data: [], unreadCount: 0 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderLoginApp();
    await user.type(screen.getByLabelText("Email address"), "faculty@example.edu");
    await user.type(screen.getByLabelText("Password"), "faculty-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("link", { name: "People" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "My enrollments" })).toBeNull();
  });

  it("clears the session and redirects to login when a protected request returns 401", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/auth/login")) return response({ success: true, data: { token: "expired-token", user: { id: "student-1", name: "Asha Student", role: "STUDENT", organizationId: "org-1" } } });
      if (String(url).includes("/notifications")) return response({ success: false, message: "Invalid or expired token" }, 401);
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderLoginApp();
    await user.type(screen.getByLabelText("Email address"), "asha@example.edu");
    await user.type(screen.getByLabelText("Password"), "campus-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Workspace dashboard" })).toBeNull();
  });

  it("returns to login when a protected route has no session", async () => {
    render(<AuthProvider><MemoryRouter initialEntries={["/private"]}><Routes>
      <Route path="/login" element={<h1>Login required</h1>} />
      <Route element={<ProtectedRoute />}><Route path="/private" element={<h1>Private details</h1>} /></Route>
    </Routes></MemoryRouter></AuthProvider>);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Login required" })).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Private details" })).toBeNull();
  });

  it("shows login failure feedback without entering an authenticated session", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ success: false, message: "Invalid email or password" }, 401)));
    renderLoginApp();
    await user.type(screen.getByLabelText("Email address"), "asha@example.edu");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Invalid email or password");
    expect(screen.queryByRole("heading", { name: "Workspace dashboard" })).toBeNull();
  });
});
