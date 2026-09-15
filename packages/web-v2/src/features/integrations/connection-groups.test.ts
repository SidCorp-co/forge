// What a closed app header claims about the connections under it (ISS-1035).
//
// The header is the whole of what an operator has to decide on before opening
// a group, so every number on it is asserted here against the state the row
// itself renders — not against a second health rule invented for the header.

import { describe, expect, it } from "vitest";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import type { DirectoryStatus } from "./derive";
import { appLabel, groupConnectionsByApp, groupSummary, tallyOf } from "./connection-groups";

function conn(over: Partial<ConnectionDirectoryItem> = {}): ConnectionDirectoryItem {
  return {
    id: "conn-1",
    ownerType: "user",
    ownerId: "user-1",
    provider: "coolify",
    displayName: null,
    config: {},
    active: true,
    lastHealthStatus: "ok",
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    usage: { bindings: [] },
    ...over,
  } as ConnectionDirectoryItem;
}

describe("tallyOf", () => {
  // Every member of the union, including the one no connection row can reach,
  // so a state added to DirectoryStatus cannot be counted by accident.
  const cases: [DirectoryStatus, "attention" | "off" | null][] = [
    ["connected", null],
    ["degraded", "attention"],
    ["error", "attention"],
    ["needs_reauth", "attention"],
    ["needs_scope", "attention"],
    ["disabled", "off"],
    ["unverified", null],
    ["not_connected", null],
  ];

  for (const [status, expected] of cases) {
    it(`counts ${status} toward ${expected ?? "neither tally"}`, () => {
      expect(tallyOf(status)).toBe(expected);
    });
  }
});

describe("groupConnectionsByApp", () => {
  it("puts every connection of one app under a single group", () => {
    const groups = groupConnectionsByApp([
      conn({ id: "a" }),
      conn({ id: "b" }),
      conn({ id: "c", provider: "github" }),
    ]);
    expect(groups.map((g) => g.provider)).toEqual(["coolify", "github"]);
    expect(groups[0].connections.map((c) => c.id)).toEqual(["a", "b"]);
    expect(groups[1].connections.map((c) => c.id)).toEqual(["c"]);
  });

  it("orders groups by label rather than by the order the API returned them in", () => {
    // Fed in reverse label order, so a group list that merely preserves
    // insertion order comes back the other way round and fails here.
    const groups = groupConnectionsByApp([
      conn({ id: "a", provider: "sentry" }),
      conn({ id: "b", provider: "github" }),
      conn({ id: "c", provider: "coolify" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Coolify deploy", "GitHub", "Sentry"]);
  });

  it("labels a provider the UI has no name for with its own key", () => {
    // `agent` is a real IntegrationProvider with no PROVIDER_LABEL entry — the
    // fallback is reachable with a valid value, not only with a cast.
    const groups = groupConnectionsByApp([conn({ provider: "agent" })]);
    expect(groups[0].label).toBe("agent");
    expect(appLabel("agent")).toBe("agent");
  });

  it("keeps the incoming order of connections inside a group", () => {
    const groups = groupConnectionsByApp([conn({ id: "z" }), conn({ id: "a" })]);
    expect(groups[0].connections.map((c) => c.id)).toEqual(["z", "a"]);
  });

  it("returns no group at all for an empty list", () => {
    expect(groupConnectionsByApp([])).toEqual([]);
  });

  it("counts a degraded, errored, re-auth-needing or scope-needing connection as attention", () => {
    const groups = groupConnectionsByApp([
      conn({ id: "a", breakerOpenedAt: "2026-09-01T00:00:00.000Z" }),
      conn({ id: "b", lastHealthStatus: "boom" }),
      conn({ id: "c", lastHealthStatus: "needs_reauth" }),
      conn({ id: "d", lastHealthStatus: "needs_scope" }),
    ]);
    expect(groups[0].needsAttention).toBe(4);
    expect(groups[0].off).toBe(0);
  });

  it("counts a switched-off connection as off and not as attention", () => {
    // Inactive AND unhealthy: `disabled` wins in deriveConnectionStatus, so the
    // operator is told it is off rather than sent to fix a credential nothing
    // is using.
    const groups = groupConnectionsByApp([conn({ active: false, lastHealthStatus: "boom" })]);
    expect(groups[0].off).toBe(1);
    expect(groups[0].needsAttention).toBe(0);
  });

  it("counts a healthy connection toward neither tally", () => {
    const groups = groupConnectionsByApp([conn({ lastHealthStatus: "ok" })]);
    expect(groups[0].needsAttention).toBe(0);
    expect(groups[0].off).toBe(0);
  });

  it("counts an active, never-health-checked connection toward neither tally", () => {
    const groups = groupConnectionsByApp([conn({ lastHealthStatus: null })]);
    expect(groups[0].connections).toHaveLength(1);
    expect(groups[0].needsAttention).toBe(0);
    expect(groups[0].off).toBe(0);
  });

  it("tallies each app separately", () => {
    const groups = groupConnectionsByApp([
      conn({ id: "a", lastHealthStatus: "needs_reauth" }),
      conn({ id: "b", provider: "github", active: false }),
    ]);
    expect(groups.find((g) => g.provider === "coolify")).toMatchObject({ needsAttention: 1, off: 0 });
    expect(groups.find((g) => g.provider === "github")).toMatchObject({ needsAttention: 0, off: 1 });
  });
});

describe("groupSummary", () => {
  it("states the count alone when nothing wants attention and nothing is off", () => {
    expect(groupSummary({ connections: [conn(), conn()], needsAttention: 0, off: 0 })).toBe(
      "2 connections",
    );
  });

  it("says connection, singular, for one", () => {
    expect(groupSummary({ connections: [conn()], needsAttention: 0, off: 0 })).toBe("1 connection");
  });

  it("states both tallies when both are non-zero", () => {
    expect(
      groupSummary({ connections: [conn(), conn(), conn()], needsAttention: 1, off: 1 }),
    ).toBe("3 connections · 1 need attention · 1 off");
  });

  it("omits the attention tally rather than printing a zero", () => {
    expect(groupSummary({ connections: [conn(), conn()], needsAttention: 0, off: 2 })).toBe(
      "2 connections · 2 off",
    );
  });

  it("omits the off tally rather than printing a zero", () => {
    expect(groupSummary({ connections: [conn(), conn()], needsAttention: 2, off: 0 })).toBe(
      "2 connections · 2 need attention",
    );
  });
});
