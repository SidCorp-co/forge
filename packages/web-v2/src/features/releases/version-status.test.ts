import { describe, expect, it } from "vitest";
import { matchesFilter, statusLabel } from "./version-status";
import type { ReleaseVersionRow } from "./versions-types";

const row = (over: Partial<ReleaseVersionRow>): ReleaseVersionRow => ({
  version: "0.1.0",
  runId: "r",
  runStatus: "running",
  status: "in_progress",
  current: false,
  openedAt: "2026-10-01T10:00:00.000Z",
  releasedAt: null,
  issueCount: 1,
  approval: null,
  stages: [],
  ...over,
});

describe("a version's label and filter", () => {
  it("calls a shipped version production only while it is the current one", () => {
    expect(statusLabel(row({ status: "shipped", current: true })).label).toBe("production");
    expect(statusLabel(row({ status: "shipped", current: false })).label).toBe("superseded");
  });

  it("puts every shipped version under Live and nothing else", () => {
    expect(matchesFilter(row({ status: "shipped" }), "live")).toBe(true);
    expect(matchesFilter(row({ status: "awaiting_approval" }), "live")).toBe(false);
    expect(matchesFilter(row({ status: "awaiting_approval" }), "awaiting_approval")).toBe(true);
    expect(matchesFilter(row({ status: "rolled_back" }), "rolled_back")).toBe(true);
    expect(matchesFilter(row({ status: "failed" }), "rolled_back")).toBe(false);
  });
});
