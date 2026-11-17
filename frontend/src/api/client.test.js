import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, setUnauthorizedHandler } from "./client.js";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

afterEach(() => setUnauthorizedHandler(null));

describe("API client", () => {
  it("sends JSON and bearer authorization, then returns the JSON response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ success: true, data: { value: 7 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest("/example", { token: "test-token", method: "POST", body: { value: 7 } }))
      .resolves.toEqual({ success: true, data: { value: 7 } });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/example"), expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer test-token", "Content-Type": "application/json" }),
      body: JSON.stringify({ value: 7 }),
    }));
  });

  it.each([400, 401, 403, 404, 409, 429, 500])("preserves the API message and HTTP %i status", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ success: false, message: `Failure ${status}` }, status)));
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    await expect(apiRequest("/example", { token: "test-token" })).rejects.toMatchObject({ status, message: `Failure ${status}` });
    expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it("shows a friendly message when the network cannot reach the API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(apiRequest("/example")).rejects.toMatchObject({
      status: 0,
      message: "Cannot reach the CampusFlow API. Check your connection and try again.",
    });
  });

  it("lets request cancellation pass through unchanged", async () => {
    const error = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    await expect(apiRequest("/example")).rejects.toBe(error);
  });
});
