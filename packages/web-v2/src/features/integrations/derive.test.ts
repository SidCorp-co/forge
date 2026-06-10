import { describe, expect, it } from "vitest";
import {
  cardProvider,
  DEFAULT_CAPABILITIES,
  deriveConnectionStatus,
  deriveDirectoryStatus,
  getCapabilities,
  isProviderCard,
  REDACTED,
  redactSensitive,
} from "./derive";
import type { StatusCard } from "./types";

function card(over: Partial<StatusCard>): StatusCard {
  return {
    key: "coolify",
    label: "Coolify",
    status: "connected",
    detail: "",
    lastSyncAt: null,
    configured: true,
    ...over,
  };
}

describe("deriveDirectoryStatus", () => {
  it("maps the server buckets to the honest directory states", () => {
    expect(deriveDirectoryStatus(card({ status: "connected" }))).toBe("connected");
    expect(deriveDirectoryStatus(card({ status: "attention" }))).toBe("degraded");
    expect(deriveDirectoryStatus(card({ status: "error" }))).toBe("error");
    expect(deriveDirectoryStatus(card({ status: "not_configured" }))).toBe("not_connected");
    // ISS-429 — existing-but-off ≠ unset, and never-checked ≠ degraded.
    expect(deriveDirectoryStatus(card({ status: "disabled" }))).toBe("disabled");
    expect(deriveDirectoryStatus(card({ status: "unverified" }))).toBe("unverified");
  });

  it("unverified still reads Degraded when the breaker is open", () => {
    expect(
      deriveDirectoryStatus(card({ status: "unverified", meta: { breakerOpen: true } })),
    ).toBe("degraded");
  });

  it("forces Degraded when the breaker is open even if status reads connected", () => {
    expect(
      deriveDirectoryStatus(card({ status: "connected", meta: { breakerOpen: true } })),
    ).toBe("degraded");
    expect(
      deriveDirectoryStatus(card({ status: "connected", meta: { breakerOpen: false } })),
    ).toBe("connected");
  });

  it("surfaces needs_reauth from raw lastHealthStatus regardless of bucket", () => {
    expect(
      deriveDirectoryStatus(
        card({ status: "attention", meta: { lastHealthStatus: "needs_reauth" } }),
      ),
    ).toBe("needs_reauth");
    // Wins over an error bucket too — credentials rejected reads as actionable,
    // not generic failure.
    expect(
      deriveDirectoryStatus(card({ status: "error", meta: { lastHealthStatus: "needs_reauth" } })),
    ).toBe("needs_reauth");
    // And over a healthy-looking connected bucket (paranoia path: server lag
    // between adapter writing the signal and the card.status being recomputed).
    expect(
      deriveDirectoryStatus(
        card({ status: "connected", meta: { lastHealthStatus: "needs_reauth" } }),
      ),
    ).toBe("needs_reauth");
    // Wins over breaker too — needs_reauth is a more specific actionable state.
    expect(
      deriveDirectoryStatus(
        card({ status: "connected", meta: { breakerOpen: true, lastHealthStatus: "needs_reauth" } }),
      ),
    ).toBe("needs_reauth");
  });

  it("does not light needs_reauth for other lastHealthStatus values", () => {
    expect(
      deriveDirectoryStatus(card({ status: "connected", meta: { lastHealthStatus: "ok" } })),
    ).toBe("connected");
    expect(
      deriveDirectoryStatus(card({ status: "attention", meta: { lastHealthStatus: "degraded" } })),
    ).toBe("degraded");
    expect(
      deriveDirectoryStatus(card({ status: "error", meta: { lastHealthStatus: "error" } })),
    ).toBe("error");
  });
});

describe("deriveConnectionStatus", () => {
  const conn = (over: Partial<Parameters<typeof deriveConnectionStatus>[0]>) => ({
    active: true,
    lastHealthStatus: null as string | null,
    breakerOpenedAt: null as string | null,
    ...over,
  });

  it("maps owner-scoped connection rows like the server buckets cards", () => {
    expect(deriveConnectionStatus(conn({ lastHealthStatus: "ok" }))).toBe("connected");
    expect(deriveConnectionStatus(conn({ lastHealthStatus: "error" }))).toBe("error");
    expect(deriveConnectionStatus(conn({ lastHealthStatus: "degraded" }))).toBe("degraded");
    expect(deriveConnectionStatus(conn({}))).toBe("unverified");
    expect(deriveConnectionStatus(conn({ active: false }))).toBe("disabled");
    expect(deriveConnectionStatus(conn({ lastHealthStatus: "needs_reauth" }))).toBe(
      "needs_reauth",
    );
  });

  it("disabled wins over health; breaker wins over ok", () => {
    expect(
      deriveConnectionStatus(conn({ active: false, lastHealthStatus: "ok" })),
    ).toBe("disabled");
    expect(
      deriveConnectionStatus(
        conn({ lastHealthStatus: "ok", breakerOpenedAt: "2026-06-01T00:00:00Z" }),
      ),
    ).toBe("degraded");
  });
});

describe("getCapabilities", () => {
  it("falls back to the conservative all-false default when meta is missing", () => {
    expect(getCapabilities(card({}))).toEqual(DEFAULT_CAPABILITIES);
    expect(getCapabilities(undefined)).toEqual(DEFAULT_CAPABILITIES);
  });

  it("overlays the card's capabilities onto the default", () => {
    const caps = getCapabilities(
      card({ meta: { capabilities: { hasDeliveryLog: true, hasEnvironments: true } } }),
    );
    expect(caps.hasDeliveryLog).toBe(true);
    expect(caps.hasEnvironments).toBe(true);
    expect(caps.canDispatch).toBe(false);
  });
});

describe("isProviderCard / cardProvider", () => {
  it("recognises drillable provider cards (including env-suffixed keys)", () => {
    expect(isProviderCard("coolify")).toBe(true);
    expect(isProviderCard("coolify:staging")).toBe(true);
    expect(isProviderCard("postman")).toBe(true);
    expect(isProviderCard("epodsystem")).toBe(true);
    expect(isProviderCard("github")).toBe(false);
    expect(isProviderCard("runners")).toBe(false);
  });

  it("extracts the provider from an env-suffixed key", () => {
    expect(cardProvider("coolify:prod")).toBe("coolify");
    expect(cardProvider("postman")).toBe("postman");
  });
});

describe("redactSensitive", () => {
  it("masks secret-looking keys at any depth and preserves the rest", () => {
    const out = redactSensitive({
      eventName: "deploy",
      apiKey: "sk-live-abc",
      nested: { webhookSecret: "whsec_xyz", branch: "main" },
      headers: { Authorization: "Bearer t0ken", "content-type": "application/json" },
      items: [{ token: "leak", id: 7 }],
    }) as Record<string, unknown>;

    expect(out.eventName).toBe("deploy");
    expect(out.apiKey).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).webhookSecret).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).branch).toBe("main");
    expect((out.headers as Record<string, unknown>).Authorization).toBe(REDACTED);
    expect((out.headers as Record<string, unknown>)["content-type"]).toBe("application/json");
    expect((out.items as Record<string, unknown>[])[0].token).toBe(REDACTED);
    expect((out.items as Record<string, unknown>[])[0].id).toBe(7);
  });

  it("does not contain the raw secret value anywhere in the serialized output", () => {
    const serialized = JSON.stringify(
      redactSensitive({ apiKey: "super-secret-value", ok: true }),
    );
    expect(serialized).not.toContain("super-secret-value");
  });

  it("leaves primitives untouched", () => {
    expect(redactSensitive("plain")).toBe("plain");
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBe(null);
  });
});
