// ISS-1421 r8, criterion 96 — judge-40 read "Turned off." beside a "Needs re-auth" pill on a
// binding turned off whose last check asked for sign-in. One state per row, and turned off wins.

import { describe, expect, it } from "vitest";
import {
  bindingForRow,
  bindingInUse,
  cardBindingId,
  DIRECTORY_STATUS_META,
  deriveConnectionStatus,
  deriveDirectoryStatus,
  STATE_WORDS,
} from "./derive";
import type { IntegrationSummary } from "./types";

describe("the state a provider's row, drawer header and badge name", () => {
  it.each(["needs_reauth", "needs_scope", "error", "ok", null])(
    "reads a turned-off binding as Turned off whatever its last check found (%s)",
    (lastHealthStatus) => {
      const status = deriveDirectoryStatus({ status: "disabled", meta: { lastHealthStatus } });
      expect(status).toBe("disabled");
      expect(DIRECTORY_STATUS_META[status].label).toBe(STATE_WORDS.off);
    },
  );

  it("reads a connection the same way the binding is read", () => {
    expect(
      deriveConnectionStatus({ active: false, lastHealthStatus: "needs_reauth", breakerOpenedAt: null }),
    ).toBe("disabled");
  });

  it("still names a binding that is on and asks for sign-in", () => {
    expect(
      deriveDirectoryStatus({ status: "connected", meta: { lastHealthStatus: "needs_reauth" } }),
    ).toBe("needs_reauth");
  });
});

// ISS-1421 r32: a removed integration connected again leaves its switched-off row beside the new one.
describe("bindingInUse", () => {
  const row = (id: string, provider: string, bindingActive: boolean, day = 1) =>
    ({ id, provider, bindingActive, createdAt: `2026-10-0${day}T00:00:00.000Z` }) as IntegrationSummary;

  it("takes the switched-on binding of the provider where a switched-off one comes first", () => {
    const items = [row("old", "rocketchat", false, 2), row("sentry", "sentry", true), row("new", "rocketchat", true, 1)];
    expect(bindingInUse(items, "rocketchat")?.id).toBe("new");
  });

  it("keeps to the newest once the one in use is switched off too, so a switch-on reaches it", () => {
    const items = [row("old", "sentry", false, 1), row("new", "sentry", false, 2)];
    expect(bindingInUse(items, "sentry")?.id).toBe("new");
  });

  it("falls back to the switched-off one where it is the only one, and to none for a provider with none", () => {
    expect(bindingInUse([row("old", "postman", false)], "postman")?.id).toBe("old");
    expect(bindingInUse([row("old", "postman", false)], "google")).toBeUndefined();
    expect(bindingInUse(undefined, "google")).toBeUndefined();
  });
});

describe("bindingForRow", () => {
  const row = (id: string, provider: string, bindingActive: boolean, day = 1) =>
    ({ id, provider, bindingActive, createdAt: `2026-10-0${day}T00:00:00.000Z` }) as IntegrationSummary;
  const items = [row("old", "sentry", false, 1), row("new", "sentry", true, 2), row("pm", "postman", true)];

  it("takes the binding the row names, the switched-off one included", () => {
    expect(bindingForRow(items, "sentry", "old")?.id).toBe("old");
    expect(bindingForRow(items, "sentry", "new")?.id).toBe("new");
  });

  it("takes the one in use only where no row names one", () => {
    expect(bindingForRow(items, "sentry", undefined)?.id).toBe("new");
  });

  it("takes none where the named binding is gone or is another provider's, never another binding", () => {
    expect(bindingForRow(items, "sentry", "gone")).toBeUndefined();
    expect(bindingForRow(items, "sentry", "pm")).toBeUndefined();
  });

  it("reads the binding a card names, and none from a card that names none", () => {
    expect(cardBindingId({ meta: { bindingId: "old" } })).toBe("old");
    expect(cardBindingId({ meta: { bindingId: "" } })).toBeUndefined();
    expect(cardBindingId({ meta: {} })).toBeUndefined();
    expect(cardBindingId(null)).toBeUndefined();
  });
});
