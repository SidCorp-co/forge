// ISS-1421 r5 — right after Connect Coolify the section read "Last deploy failed" for a binding that
// had never deployed, and "Breaker open" for one that was turned off.

import { describe, expect, it } from "vitest";
import type { IntegrationSummary } from "../../types";
import { badgeFor } from "./section";

const binding = (over: Partial<IntegrationSummary>) =>
  ({ active: true, lastHealthStatus: null, breakerOpenedAt: null, ...over }) as IntegrationSummary;

describe("badgeFor", () => {
  it("says a failed health check is a failed check, never a failed deploy", () => {
    expect(badgeFor(binding({ lastHealthStatus: "error" })).label).toBe("Last check failed");
  });

  it("says a binding turned off is turned off, as the Status row does", () => {
    expect(badgeFor(binding({ active: false, lastHealthStatus: "error" }))).toEqual({
      label: "Turned off",
      tone: "neutral",
    });
  });

  it("names an open breaker only where the binding holds one", () => {
    expect(badgeFor(binding({ breakerOpenedAt: "2026-10-17T00:00:00Z" })).label).toBe("Degraded");
  });

  it("reads Connected, Not checked yet and Not configured from what is there", () => {
    expect(badgeFor(binding({ lastHealthStatus: "ok" })).label).toBe("Connected");
    expect(badgeFor(binding({})).label).toBe("Not checked yet");
    expect(badgeFor(undefined).label).toBe("Not configured");
  });
});
