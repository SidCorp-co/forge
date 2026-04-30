import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Layer C of the v0.1.26 logout-race fix: `client.request()` throws when
// invoked before `configureApi()` has set a baseUrl. This pins the safety
// net so any future change that re-introduces a hardcoded module-level
// default (e.g. `localhost:8080` from v0.1.25) is caught by tests rather
// than by an operator's Sentry inbox.

describe("lib/api/client request() pre-config guard", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when called before configureApi()", async () => {
    const { request } = await import("@/lib/api/client");
    await expect(request("/anything")).rejects.toThrow(
      /API not configured: request before configureApi/,
    );
  });

  it("succeeds (reaches fetch) once configureApi has run", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { configureApi, request } = await import("@/lib/api/client");
    configureApi("https://api.example.com", "jwt-token");
    const result = await request<{ ok: boolean }>("/ping");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/api/ping");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer jwt-token",
    });
    expect(result).toEqual({ ok: true });
  });
});
