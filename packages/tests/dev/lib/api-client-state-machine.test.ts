import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAuthStoreForTest, useAuthStore, type AuthState } from "@/stores/auth-store";
import { request, getAuthToken, getBaseUrl } from "@/lib/api/client";

vi.mock("@/hooks/use-tauri-ipc", () => ({ invoke: vi.fn() }));

const fetchMock = vi.fn();
const flush = () => new Promise<void>((r) => queueMicrotask(r));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  _resetAuthStoreForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setAuthenticated() {
  useAuthStore.setState({
    phase: "authenticated",
    coreUrl: "https://api.example.com",
    token: "jwt-1",
    deviceId: "dev-1",
  } as AuthState as ReturnType<typeof useAuthStore.getState>);
}

function setUnauthenticated() {
  useAuthStore.setState({
    phase: "unauthenticated",
    coreUrl: null,
    deviceId: null,
  } as AuthState as ReturnType<typeof useAuthStore.getState>);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api/client request() phase guard", () => {
  it("throws when phase === 'hydrating'", async () => {
    await expect(request("/anything")).rejects.toThrow(/API not configured: request in phase hydrating/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when phase === 'unauthenticated'", async () => {
    setUnauthenticated();
    await expect(request("/anything")).rejects.toThrow(/API not configured: request in phase unauthenticated/);
  });

  it("succeeds when phase === 'authenticated' — reads coreUrl + token from the store", async () => {
    setAuthenticated();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await request<{ ok: boolean }>("/ping");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/api/ping");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer jwt-1",
    });
    expect(result).toEqual({ ok: true });
  });

  it("propagates auth state changes — first call uses old token, second uses new", async () => {
    setAuthenticated();
    // Each fetch invocation must return a fresh Response — Body.json() is a
    // one-shot stream so a single shared response would 'Body is unusable'
    // on the second call.
    fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true }));
    await request("/a");
    useAuthStore.setState({
      phase: "authenticated",
      coreUrl: "https://api.example.com",
      token: "jwt-2",
      deviceId: "dev-1",
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
    await request("/b");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt-1" });
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt-2" });
  });
});

describe("api/client 401 → store.expire() dispatch", () => {
  beforeEach(() => setAuthenticated());

  it("dispatches expire() on 401 INVALID_TOKEN and rethrows", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: "INVALID_TOKEN", message: "invalid" }));
    await expect(request("/projects")).rejects.toThrow(/401/);
    await flush();
    expect(useAuthStore.getState().phase).toBe("expired");
  });

  it("dispatches expire() on 401 UNAUTHENTICATED", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: "UNAUTHENTICATED", message: "auth required" }));
    await expect(request("/projects")).rejects.toThrow(/401/);
    await flush();
    expect(useAuthStore.getState().phase).toBe("expired");
  });

  it("does NOT dispatch expire() on non-auth 4xx responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { code: "FORBIDDEN", message: "no" }));
    await expect(request("/projects")).rejects.toThrow(/403/);
    await flush();
    expect(useAuthStore.getState().phase).toBe("authenticated");
  });

  it("dispatches expire() on 401 with non-JSON body (defensive)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nginx 401 page", { status: 401, headers: { "Content-Type": "text/html" } }),
    );
    await expect(request("/projects")).rejects.toThrow(/401/);
    await flush();
    expect(useAuthStore.getState().phase).toBe("expired");
  });
});

describe("api/client compat shims", () => {
  it("getBaseUrl() returns coreUrl in authenticated/expired/unauthenticated phases, '' in hydrating", () => {
    expect(getBaseUrl()).toBe("");
    setAuthenticated();
    expect(getBaseUrl()).toBe("https://api.example.com");
    useAuthStore.setState({
      phase: "expired",
      coreUrl: "https://api.example.com",
      deviceId: "dev-1",
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
    expect(getBaseUrl()).toBe("https://api.example.com");
    setUnauthenticated();
    expect(getBaseUrl()).toBe("");
  });

  it("getAuthToken() returns the JWT only in authenticated phase", () => {
    expect(getAuthToken()).toBe("");
    setAuthenticated();
    expect(getAuthToken()).toBe("jwt-1");
    useAuthStore.setState({
      phase: "expired",
      coreUrl: "https://api.example.com",
      deviceId: "dev-1",
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
    expect(getAuthToken()).toBe("");
  });
});
