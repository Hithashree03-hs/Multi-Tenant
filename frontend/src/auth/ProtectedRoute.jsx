import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";
import { Loading } from "../components/ui.jsx";

export function ProtectedRoute({ allowedRoles }) {
  const { isAuthenticated, isInitializing, user } = useAuth();
  const location = useLocation();
  if (isInitializing) return <Loading label="Checking your session…" />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (allowedRoles && !allowedRoles.includes(user?.role)) return <Navigate to="/" replace />;
  return <Outlet />;
}
