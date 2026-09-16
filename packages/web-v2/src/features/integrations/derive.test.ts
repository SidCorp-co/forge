import { describe, expect, it } from "vitest";
import {
  cardProvider,
  DEFAULT_CAPABILITIES,
  DIRECTORY_STATUS_META,
  deriveConnectionStatus,
  deriveDirectoryStatus,
  getCapabilities,
  groupCardsByProvider,
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
    expect(
      deriveDirectoryStatus(
        card({ status: "connected", meta: { breakerOpen: true, lastHealthStatus: "needs_reauth" } }),
      ),
    ).toBe("needs_reauth");
  });

  it("renders needs_scope as its own state, never needs_reauth (ISS-924)", () => {
    expect(
      deriveDirectoryStatus(card({ status: "error", meta: { lastHealthStatus: "needs_scope" } })),
    ).toBe("needs_scope");
    expect(
      deriveDirectoryStatus(
        card({ status: "attention", meta: { lastHealthStatus: "needs_scope" } }),
      ),
    ).toBe("needs_scope");
    expect(
      deriveDirectoryStatus(
        card({ status: "connected", meta: { breakerOpen: true, lastHealthStatus: "needs_scope" } }),
      ),
    ).toBe("needs_scope");
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
    expect(deriveConnectionStatus(conn({ lastHealthStatus: "needs_scope" }))).toBe("needs_scope");
  });

  it("gives needs_scope a label of its own, so the two credential states never read alike", () => {
    expect(DIRECTORY_STATUS_META.needs_scope.label).not.toBe(
      DIRECTORY_STATUS_META.needs_reauth.label,
    );
    expect(DIRECTORY_STATUS_META.needs_scope.icon).toBeTruthy();
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
      card({ meta: { capabilities: { hasDeliveryLog: true, canDeploy: true } } }),
    );
    expect(caps.hasDeliveryLog).toBe(true);
    expect(caps.canDeploy).toBe(true);
    expect(caps.canDispatch).toBe(false);
  });
});

describe("isProviderCard / cardProvider", () => {
  it("recognises drillable provider cards (including env-suffixed keys)", () => {
    expect(isProviderCard("coolify")).toBe(true);
    expect(isProviderCard("coolify:staging")).toBe(true);
    expect(isProviderCard("postman")).toBe(true);
    expect(isProviderCard("epodsystem")).toBe(true);
    expect(isProviderCard("github")).toBe(true);
    expect(isProviderCard("runners")).toBe(false);
  });

  it("extracts the provider from a stage-suffixed key", () => {
    expect(cardProvider("coolify:live")).toBe("coolify");
    expect(cardProvider("coolify:preview+live")).toBe("coolify");
    expect(cardProvider("postman")).toBe("postman");
  });
});

describe("groupCardsByProvider", () => {
  it("consolidates stage-split coolify cards into one group, live before preview", () => {
    const groups = groupCardsByProvider([
      card({
        key: "coolify:preview",
        label: "Coolify (Preview)",
        meta: { role: "deploy", stages: ["preview"] },
      }),
      card({ key: "github", label: "GitHub" }),
      card({
        key: "coolify:live",
        label: "Coolify (Live)",
        meta: { role: "deploy", stages: ["live"] },
      }),
    ]);
    // First-seen provider order preserved: coolify before github.
    expect(groups.map((g) => g.provider)).toEqual(["coolify", "github"]);
    const coolify = groups[0];
    expect(coolify.cards).toHaveLength(2);
    // Deterministic live-then-preview order regardless of input order.
    expect(coolify.cards.map((c) => c.key)).toEqual(["coolify:live", "coolify:preview"]);
    expect(groups[1].cards).toHaveLength(1);
  });

  // cm:guard a service row sorts LAST, under both deploy stages. Without this the
  // rank could return the same number for every input and the two cases above would
  // still pass, because a sort that ties leaves the input order — and the input
  // order there already happens to be the answer for one of them.
  it("sorts a service row below both deploy stages", () => {
    const groups = groupCardsByProvider([
      card({
        key: "epodsystem:service",
        label: "ePOD (service)",
        meta: { role: "service", stages: [] },
      }),
      card({
        key: "epodsystem:preview",
        label: "ePOD (Preview)",
        meta: { role: "deploy", stages: ["preview"] },
      }),
      card({
        key: "epodsystem:live",
        label: "ePOD (Live)",
        meta: { role: "deploy", stages: ["live"] },
      }),
    ]);
    expect(groups[0].cards.map((c) => c.key)).toEqual([
      "epodsystem:live",
      "epodsystem:preview",
      "epodsystem:service",
    ]);
  });

  it("ranks a binding serving both stages as live", () => {
    const groups = groupCardsByProvider([
      card({
        key: "epodsystem:preview",
        label: "ePOD (Preview)",
        meta: { role: "deploy", stages: ["preview"] },
      }),
      card({
        key: "epodsystem:preview+live",
        label: "ePOD (Preview + Live)",
        meta: { role: "deploy", stages: ["preview", "live"] },
      }),
    ]);
    expect(groups[0].cards.map((c) => c.key)).toEqual([
      "epodsystem:preview+live",
      "epodsystem:preview",
    ]);
  });

  it("leaves a single coolify binding as a 1-card group (renders as today)", () => {
    const groups = groupCardsByProvider([card({ key: "coolify:live", label: "Coolify (Live)" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].cards).toHaveLength(1);
  });

  it("falls back to the key suffix when meta carries no role or stages", () => {
    const groups = groupCardsByProvider([
      card({ key: "coolify:preview", label: "Coolify (Preview)" }),
      card({ key: "coolify:live", label: "Coolify (Live)" }),
    ]);
    expect(groups[0].cards.map((c) => c.key)).toEqual(["coolify:live", "coolify:preview"]);
  });

  it("returns an empty array for no cards", () => {
    expect(groupCardsByProvider([])).toEqual([]);
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
