import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, cancelAuthenticatedRequests, setUnauthorizedHandler } from "../api/client.js";

const AuthContext = createContext(null);
const TOKEN_STORAGE_KEY = "campusflow.auth.token";

function readStoredToken() {
  try { return window.sessionStorage.getItem(TOKEN_STORAGE_KEY); }
  catch { return null; }
}

function storeToken(token) {
  try { window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token); }
  catch { /* Keep this login usable in browsers that disable session storage. */ }
}

function removeStoredToken() {
  try { window.sessionStorage.removeItem(TOKEN_STORAGE_KEY); }
  catch { /* The in-memory session is still cleared when storage is unavailable. */ }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const activeTokenRef = useRef(null);

  const logout = useCallback(() => {
    activeTokenRef.current = null;
    removeStoredToken();
    cancelAuthenticatedRequests();
    setSession(null);
  }, []);

  const handleUnauthorized = useCallback((failedToken) => {
    // A late response from a previous account must not log out a newer session.
    if (failedToken && activeTokenRef.current === failedToken) logout();
  }, [logout]);

  useEffect(() => {
    setUnauthorizedHandler(handleUnauthorized);
    return () => setUnauthorizedHandler(null);
  }, [handleUnauthorized]);

  useEffect(() => {
    const token = readStoredToken();
    if (!token) {
      setIsInitializing(false);
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    activeTokenRef.current = token;
    apiRequest("/auth/me", { token, signal: controller.signal })
      .then((result) => {
        if (active && activeTokenRef.current === token) {
          // Only the server's current database-backed profile is restored.
          setSession({ token, user: result.data.user });
        }
      })
      .catch((error) => {
        if (active && error?.name !== "AbortError") {
          if (error?.status === 401 || error?.status === 404) logout();
          else {
            // Fail closed while the API is unavailable, but let a later reload retry the token.
            activeTokenRef.current = null;
            setSession(null);
          }
        }
      })
      .finally(() => { if (active) setIsInitializing(false); });

    return () => {
      active = false;
      controller.abort();
    };
  }, [logout]);

  const login = useCallback(async (email, password) => {
    const result = await apiRequest("/auth/login", { method: "POST", body: { email, password } });
    activeTokenRef.current = result.data.token;
    storeToken(result.data.token);
    setSession({ token: result.data.token, user: result.data.user });
    return result.data.user;
  }, []);

  const register = useCallback(async (name, email, password) => {
    const result = await apiRequest("/auth/register", { method: "POST", body: { name, email, password } });
    return result.data.user;
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!session?.token) return null;
    const token = session.token;
    const result = await apiRequest("/auth/me", { token });
    if (activeTokenRef.current !== token) return null;
    setSession((current) => current?.token === token ? { ...current, user: result.data.user } : current);
    return result.data.user;
  }, [session?.token]);

  const value = useMemo(() => ({
    session,
    user: session?.user || null,
    token: session?.token || null,
    isAuthenticated: Boolean(session?.token),
    isInitializing,
    login,
    register,
    logout,
    refreshProfile,
  }), [session, isInitializing, login, register, logout, refreshProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
