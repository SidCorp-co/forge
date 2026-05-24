import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_hostname") return "forge-host";
    return "";
  }),
}));

vi.mock("@/lib/api-discovery", () => ({
  resolveApiBase: vi.fn(async (u: string) => u),
}));

type Breadcrumb = {
  category?: string;
  level?: string;
  message?: string;
  data?: Record<string, unknown>;
};
const addBreadcrumb = vi.fn<(b: Breadcrumb) => void>();
vi.mock("@/lib/sentry", () => ({
  Sentry: {
    addBreadcrumb: (b: Breadcrumb) => addBreadcrumb(b),
  },
}));

const { startPairing } = await import("@/lib/pairing");
type PairingPhase = import("@/lib/pairing").PairingPhase;

const fetchMock = vi.fn<typeof fetch>();

const ISO_FUTURE = () => new Date(Date.now() + 5 * 60_000).toISOString();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  addBreadcrumb.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pairInitResponse() {
  return jsonRes({ pairing_code: "H7P-Q3K7", expires_at: ISO_FUTURE() });
}

describe("startPairing — happy path", () => {
  it("transitions initializing → awaiting-approval → consuming-code → authenticated", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/pair-init")) return pairInitResponse();
      if (url.includes("/poll")) {
        // First poll → 204 pending. Second poll → 200 with token.
        if (fetchMock.mock.calls.length === 2) {
          return new Response(null, { status: 204 });
        }
        return jsonRes({ token: "jwt-1", user: { id: "u1", email: "a@b" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const phases: PairingPhase[] = [];
    const handle = await startPairing({
      coreUrl: "https://api.example.com",
      onPhase: (p) => phases.push(p),
    });

    expect(handle.pairingCode).toBe("H7P-Q3K7");
    expect(handle.connectUrl).toContain("/connect-device?code=H7P-Q3K7");

    // Run the polling loop. First setTimeout fires at 2000ms → 204 pending.
    await vi.advanceTimersByTimeAsync(2_000);
    // Second setTimeout fires at 2000ms → 200 token.
    await vi.advanceTimersByTimeAsync(2_000);

    const { token, user } = await handle.done;
    expect(token).toBe("jwt-1");
    expect(user).toEqual({ id: "u1", email: "a@b" });
    expect(phases).toEqual([
      "initializing",
      "awaiting-approval",
      "consuming-code",
      "authenticated",
    ]);
  });
});

describe("startPairing — cancel", () => {
  it("rejects with phase=cancelled when cancel() is called", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/pair-init")) return pairInitResponse();
      return new Response(null, { status: 204 });
    });

    const phases: PairingPhase[] = [];
    const handle = await startPairing({
      coreUrl: "https://api.example.com",
      onPhase: (p) => phases.push(p),
    });

    handle.cancel();
    await expect(handle.done).rejects.toThrow(/cancelled/);
    expect(phases).toContain("cancelled");
  });
});

describe("startPairing — expiry", () => {
  it("emits expired and rejects when expires_at passes", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/pair-init")) {
        return jsonRes({
          pairing_code: "H7P-Q3K7",
          // Expire 1ms in the future so the first poll tick is already past it.
          expires_at: new Date(Date.now() + 1).toISOString(),
        });
      }
      return new Response(null, { status: 204 });
    });

    const phases: PairingPhase[] = [];
    const handle = await startPairing({
      coreUrl: "https://api.example.com",
      onPhase: (p) => phases.push(p),
    });

    const expectation = expect(handle.done).rejects.toThrow(/expired/);
    await vi.advanceTimersByTimeAsync(2_010);
    await expectation;
    expect(phases).toContain("expired");
  });
});

describe("startPairing — 410 from poll", () => {
  it("emits expired and rejects when poll returns 410", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/pair-init")) return pairInitResponse();
      return jsonRes({ code: "PAIRING_CODE_CONSUMED", message: "consumed" }, 410);
    });

    const phases: PairingPhase[] = [];
    const handle = await startPairing({
      coreUrl: "https://api.example.com",
      onPhase: (p) => phases.push(p),
    });

    const expectation = expect(handle.done).rejects.toThrow(/consumed|HTTP 410/);
    await vi.advanceTimersByTimeAsync(2_010);
    await expectation;
    expect(phases).toContain("expired");
  });
});

describe("startPairing — pair-init failure", () => {
  it("throws when pair-init returns non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ code: "RATE_LIMITED" }, 429));
    await expect(
      startPairing({ coreUrl: "https://api.example.com" }),
    ).rejects.toThrow(/pair-init failed/);
  });
});
