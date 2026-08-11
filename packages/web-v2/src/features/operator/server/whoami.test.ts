import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { cookies } from "next/headers";
import { getOperatorWhoami } from "./whoami";

function mockCookies(token: string | undefined) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (name === "forge_auth" && token ? { value: token } : undefined),
    // biome-ignore lint/suspicious/noExplicitAny: only `.get` is exercised by getOperatorWhoami
  } as any);
}

describe("getOperatorWhoami", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockCookies("token123");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns unauthenticated when there is no auth cookie", async () => {
    mockCookies(undefined);
    expect(await getOperatorWhoami()).toEqual({ kind: "unauthenticated" });
  });

  it("returns unauthenticated on a 401 response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 401, ok: false });
    expect(await getOperatorWhoami()).toEqual({ kind: "unauthenticated" });
  });

  it("maps a 403 EMAIL_NOT_VERIFIED body to kind unverified", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ status: 403, ok: false, json: async () => ({ code: "EMAIL_NOT_VERIFIED" }) });
    expect(await getOperatorWhoami()).toEqual({ kind: "unverified" });
  });

  it("maps any other 403 body to kind not-admin", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ status: 403, ok: false, json: async () => ({ code: "ADMIN_ONLY" }) });
    expect(await getOperatorWhoami()).toEqual({ kind: "not-admin" });
  });

  it("returns an error with the status on a 5xx response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 500, ok: false });
    expect(await getOperatorWhoami()).toEqual({ kind: "error", message: "Request failed (500)" });
  });

  it("returns not-admin when the body says isAdmin: false", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ status: 200, ok: true, json: async () => ({ isAdmin: false, email: "a@b.com" }) });
    expect(await getOperatorWhoami()).toEqual({ kind: "not-admin" });
  });

  it("returns admin + email when the body says isAdmin: true", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ status: 200, ok: true, json: async () => ({ isAdmin: true, email: "a@b.com" }) });
    expect(await getOperatorWhoami()).toEqual({ kind: "admin", email: "a@b.com" });
  });

  it("returns an error result on a network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await getOperatorWhoami()).toEqual({
      kind: "error",
      message: "Couldn't reach the server. Check your connection and retry.",
    });
  });
});
