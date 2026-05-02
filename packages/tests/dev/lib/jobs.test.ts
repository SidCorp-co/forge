import { describe, it, expect, vi, beforeEach } from "vitest";
import { postJobEvents, completeJob, failJob, _resetDeviceTokenCacheForTest } from "@/lib/api/jobs";
import { useAuthStore, type AuthState } from "@/stores/auth-store";

const mockInvoke = vi.fn();
vi.mock("@/hooks/use-tauri-ipc", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockInvoke.mockReset();
  mockFetch.mockReset();
  _resetDeviceTokenCacheForTest();
  // jobs.ts reads coreUrl via getBaseUrl() → auth store. Drive the store
  // into authenticated so getBaseUrl returns the test origin.
  useAuthStore.setState({
    phase: "authenticated",
    coreUrl: "http://localhost:8080",
    token: "user-token",
    deviceId: "dev-1",
  } as AuthState as ReturnType<typeof useAuthStore.getState>);
});

describe("api/jobs", () => {
  it("postJobEvents sends Authorization: Bearer <deviceToken> (not the user token)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => (cmd === "load_device_token" ? "device-abc" : null));
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });

    await postJobEvents("job-1", [{ kind: "stdout", data: { text: "hi" } }]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8080/api/jobs/job-1/events");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer device-abc");
    expect(JSON.parse(init.body)).toEqual({
      events: [{ kind: "stdout", data: { text: "hi" } }],
    });
  });

  it("postJobEvents chunks batches above the 100-event server cap", async () => {
    mockInvoke.mockResolvedValue("device-abc");
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });

    const events = Array.from({ length: 250 }, (_, i) => ({ kind: "stdout" as const, data: { i } }));
    await postJobEvents("job-1", events);

    expect(mockFetch).toHaveBeenCalledTimes(3); // 100 + 100 + 50
    const sizes = mockFetch.mock.calls.map((c) => JSON.parse(c[1].body).events.length);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it("postJobEvents skips fetch when given an empty list", async () => {
    mockInvoke.mockResolvedValue("device-abc");
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });

    await postJobEvents("job-1", []);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when device token is missing — caller decides what to do", async () => {
    mockInvoke.mockResolvedValue(null);
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });

    await expect(postJobEvents("job-1", [{ kind: "stdout" }])).rejects.toThrow(/device token unavailable/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("clears the cached device token on 401 so the next call refetches", async () => {
    mockInvoke
      .mockImplementationOnce(async () => "stale-token")
      .mockImplementationOnce(async () => "fresh-token");
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });

    await expect(postJobEvents("job-1", [{ kind: "stdout" }])).rejects.toThrow(/401/);
    await postJobEvents("job-1", [{ kind: "stdout" }]);

    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
  });

  it("completeJob posts exitCode and (when present) error", async () => {
    mockInvoke.mockResolvedValue("device-abc");
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });

    await completeJob("job-1", 0);
    await completeJob("job-1", 2, { error: "boom" });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ exitCode: 0 });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ exitCode: 2, error: "boom" });
  });

  it("failJob posts the error string to /fail", async () => {
    mockInvoke.mockResolvedValue("device-abc");
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });

    await failJob("job-1", "no repoPath");

    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:8080/api/jobs/job-1/fail");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ error: "no repoPath" });
  });
});
