import { describe, expect, it } from "vitest";
import {
  cardProvider,
  DEFAULT_CAPABILITIES,
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
  it("maps the server buckets to the 4 honest directory states", () => {
    expect(deriveDirectoryStatus(card({ status: "connected" }))).toBe("connected");
    expect(deriveDirectoryStatus(card({ status: "attention" }))).toBe("degraded");
    expect(deriveDirectoryStatus(card({ status: "error" }))).toBe("error");
    expect(deriveDirectoryStatus(card({ status: "not_configured" }))).toBe("not_connected");
  });

  it("forces Degraded when the breaker is open even if status reads connected", () => {
    expect(
      deriveDirectoryStatus(card({ status: "connected", meta: { breakerOpen: true } })),
    ).toBe("degraded");
    expect(
      deriveDirectoryStatus(card({ status: "connected", meta: { breakerOpen: false } })),
    ).toBe("connected");
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
