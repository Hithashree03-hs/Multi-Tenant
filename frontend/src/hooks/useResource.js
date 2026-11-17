import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../api/client.js";
import { useAuth } from "../auth/AuthContext.jsx";

export function useResource(path, options = {}) {
  const { token } = useAuth();
  const [data, setData] = useState(options.initialData ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const reload = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!path || !token) {
      setData(options.initialData ?? null);
      setError("");
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setData(options.initialData ?? null);
    setLoading(true);
    setError("");
    apiRequest(path, { token, signal: controller.signal })
      .then((result) => { if (active) setData(result); })
      .catch((failure) => {
        if (active && failure.name !== "AbortError") setError(failure.message || "Could not load this information.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [path, token, refreshKey]);

  return { data, setData, loading, error, reload };
}

export function useApi() {
  const { token } = useAuth();
  return useCallback((path, options = {}) => apiRequest(path, { ...options, token }), [token]);
}

export function toIsoDateTime(value) {
  return value ? new Date(value).toISOString() : null;
}
