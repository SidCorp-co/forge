import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  signInWithProvider,
  type DesktopOAuthPhase,
} from "@/lib/desktop-oauth";

// === Mocks ===

type DeepLinkHandler = (event: { payload: string }) => void | Promise<void>;
let currentHandler: DeepLinkHandler | null = null;
const unlistenMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: DeepLinkHandler) => {
    currentHandler = handler;
    return unlistenMock;
  }),
}));

const openUrlMock = vi.fn();
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: (...args: unknown[]) => openUrlMock(...args),
}));

vi.mock("@/lib/api-discovery", () => ({
  resolveApiBase: vi.fn(async (u: string) => u),
}));

// Capture every breadcrumb the lib emits so we can assert on payload shape.
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

// Web-crypto polyfill for vitest jsdom — randomUUID/subtle suffice for PKCE.
const fetchMock = vi.fn();

const HANDOFF = "handoff-1234567";
const CODE = "code-abcdefghij";
const CALLBACK_URL = `forge-beta://auth/callback?handoff_id=${HANDOFF}&code=${CODE}`;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  openUrlMock.mockReset();
  unlistenMock.mockReset();
  addBreadcrumb.mockReset();
  currentHandler = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("signInWithProvider — phase callbacks", () => {
  it("fires onPhase in documented order for the happy path", async () => {
    openUrlMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ token: "jwt-1", user: { id: "u1", email: "a@b" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const phases: DesktopOAuthPhase[] = [];
    const flow = signInWithProvider({
      coreUrl: "http://api.example.com",
      provider: "github",
      onPhase: (p) => phases.push(p),
    });

    // Allow listen() + openUrl() promises to settle.
    await tick();
    await tick();
    expect(currentHandler).not.toBeNull();

    // Simulate the OS firing the deep-link.
    await currentHandler!({ payload: CALLBACK_URL });

    const result = await flow;
    expect(result.token).toBe("jwt-1");
    expect(phases).toEqual([
      "starting",
      "awaiting-deep-link",
      "deep-link-received",
      "exchanging-code",
      "exchanged",
    ]);
  });

  it("fires 'timed-out' when /exchange never resolves within the post-deep-link budget", async () => {
    // Real timers for setup: the PKCE challenge calls `crypto.subtle.digest`
    // which is async but not timer-backed, and starting under fake timers
    // raced the `listen()` mock that wires up `currentHandler` (CI flake at
    // expect(currentHandler).not.toBeNull on line 120). Switch to fake
    // timers AFTER the handler is wired, then advance past the 30 s inner
    // timeout deterministically.
    openUrlMock.mockResolvedValue(undefined);
    // fetch returns a pending promise so the exchange step hangs.
    fetchMock.mockReturnValue(new Promise(() => {}));

    const phases: DesktopOAuthPhase[] = [];
    const flow = signInWithProvider({
      coreUrl: "http://api.example.com",
      provider: "github",
      onPhase: (p) => phases.push(p),
    }).catch((e) => e);

    await tick();
    await tick();
    expect(currentHandler).not.toBeNull();

    vi.useFakeTimers({ shouldAdvanceTime: false });

    // Fire the deep-link but do NOT await — exchangeCode awaits a never-
    // resolving fetch, so awaiting the handler would deadlock the test.
    void currentHandler!({ payload: CALLBACK_URL });
    await vi.advanceTimersByTimeAsync(0);

    // Advance past the 30s post-deep-link inner timeout.
    await vi.advanceTimersByTimeAsync(31_000);

    const err = (await flow) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Exchange timed out/);
    expect(phases).toContain("timed-out");
  }, 10_000);
});

describe("signInWithProvider — Sentry breadcrumb redaction", () => {
  it("'deep-link-received' breadcrumb carries lengths, never the raw code/handoff_id", async () => {
    openUrlMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ token: "jwt-1", user: { id: "u1", email: "a@b" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const flow = signInWithProvider({
      coreUrl: "http://api.example.com",
      provider: "github",
    });
    await tick();
    await tick();
    await currentHandler!({ payload: CALLBACK_URL });
    await flow;

    const received = addBreadcrumb.mock.calls
      .map(([b]) => b)
      .find((b) => b.message === "oauth:deep-link-received");
    expect(received).toBeDefined();
    expect(received!.data).toEqual({
      handoff_id_len: HANDOFF.length,
      code_len: CODE.length,
    });

    // No breadcrumb may carry the raw secrets in any field.
    for (const [b] of addBreadcrumb.mock.calls) {
      const serialized = JSON.stringify(b);
      expect(serialized).not.toContain(CODE);
      expect(serialized).not.toContain(HANDOFF);
    }
  });
});
