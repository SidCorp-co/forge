import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureApi, request, setAuthExpiredHandler } from "@/lib/api/client";

const fetchMock = vi.fn();
const flush = () => new Promise<void>((r) => queueMicrotask(r));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  configureApi("http://test", "old-jwt");
});

afterEach(() => {
  setAuthExpiredHandler(null);
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api/client auth-expired interceptor", () => {
  it("invokes the handler on 401 INVALID_TOKEN and rethrows the API error", async () => {
    const handler = vi.fn();
    setAuthExpiredHandler(handler);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { code: "INVALID_TOKEN", message: "invalid token" }),
    );

    await expect(request("/projects")).rejects.toThrow(/401/);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("invokes the handler on 401 UNAUTHENTICATED", async () => {
    const handler = vi.fn();
    setAuthExpiredHandler(handler);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { code: "UNAUTHENTICATED", message: "auth required" }),
    );

    await expect(request("/projects")).rejects.toThrow(/401/);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke the handler on non-auth 4xx responses", async () => {
    const handler = vi.fn();
    setAuthExpiredHandler(handler);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { code: "FORBIDDEN", message: "no" }),
    );

    await expect(request("/projects")).rejects.toThrow(/403/);
    await flush();
    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes the handler on 401 when body is non-JSON (defensive)", async () => {
    const handler = vi.fn();
    setAuthExpiredHandler(handler);
    fetchMock.mockResolvedValueOnce(
      new Response("nginx 401 page", {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }),
    );

    await expect(request("/projects")).rejects.toThrow(/401/);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no handler is set (caller still gets the throw)", async () => {
    setAuthExpiredHandler(null);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { code: "INVALID_TOKEN" }),
    );
    await expect(request("/projects")).rejects.toThrow(/401/);
    // no assertion — just must not crash
  });
});
