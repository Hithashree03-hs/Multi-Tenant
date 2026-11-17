import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext.jsx";
import { ProtectedRoute } from "./auth/ProtectedRoute.jsx";
import AppShell from "./components/AppShell.jsx";
import { LoginPage, RegisterPage } from "./pages/AuthPages.jsx";
import {
  AttendancePage, CourseDetailPage, CoursesPage, DashboardPage, DepartmentDetailPage,
  DepartmentsPage, EnrollmentsPage, NotFoundPage, NotificationsPage, OrganizationPage,
  ProfilePage, ProjectDetailPage, ProjectsPage, UserDetailPage, UsersPage,
} from "./pages/WorkspacePages.jsx";

export default function App() {
  return <AuthProvider><BrowserRouter><Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/register" element={<RegisterPage />} />
    <Route element={<ProtectedRoute />}><Route element={<AppShell />}>
      <Route index element={<DashboardPage />} />
      <Route path="organization" element={<OrganizationPage />} />
      <Route path="departments" element={<DepartmentsPage />} />
      <Route path="departments/:id" element={<DepartmentDetailPage />} />
      <Route element={<ProtectedRoute allowedRoles={["ADMIN", "FACULTY"]} />}>
        <Route path="users" element={<UsersPage />} />
        <Route path="users/:id" element={<UserDetailPage />} />
      </Route>
      <Route path="courses" element={<CoursesPage />} />
      <Route path="courses/:id" element={<CourseDetailPage />} />
      <Route element={<ProtectedRoute allowedRoles={["STUDENT"]} />}>
        <Route path="enrollments" element={<EnrollmentsPage />} />
      </Route>
      <Route path="attendance" element={<AttendancePage />} />
      <Route path="projects" element={<ProjectsPage />} />
      <Route path="projects/:id" element={<ProjectDetailPage />} />
      <Route path="notifications" element={<NotificationsPage />} />
      <Route path="profile" element={<ProfilePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route></Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></BrowserRouter></AuthProvider>;
}
