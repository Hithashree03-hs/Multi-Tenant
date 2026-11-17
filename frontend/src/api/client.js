const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://localhost:5000/api").replace(/\/$/, "");
let unauthorizedHandler = null;
const authenticatedRequests = new Set();

export class ApiError extends Error {
  constructor(status, message, payload) {
    super(message || "Something went wrong. Please try again.");
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

export function cancelAuthenticatedRequests() {
  for (const controller of authenticatedRequests) controller.abort();
  authenticatedRequests.clear();
}

export async function apiRequest(path, { token, method = "GET", body, signal } = {}) {
  const requestController = token ? new AbortController() : null;
  let removeAbortListener;
  if (requestController) {
    authenticatedRequests.add(requestController);
    if (signal) {
      if (signal.aborted) requestController.abort();
      else {
        const abortRequest = () => requestController.abort();
        signal.addEventListener("abort", abortRequest, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abortRequest);
      }
    }
  }

  try {
    let response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        signal: requestController?.signal || signal,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ApiError(0, "Cannot reach the CampusFlow API. Check your connection and try again.");
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (response.status === 401 && token && unauthorizedHandler) unauthorizedHandler(token);
    if (!response.ok) {
      throw new ApiError(response.status, payload?.message || `Request failed (${response.status})`, payload);
    }
    return payload;
  } finally {
    removeAbortListener?.();
    if (requestController) authenticatedRequests.delete(requestController);
  }
}

export function getApiBaseUrl() {
  return API_BASE_URL;
}
