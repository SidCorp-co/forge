import { describe, expect, it } from "vitest";
import {
  detailLine,
  eventStage,
  parseAction,
  relativeTime,
  todayStats,
  verbLabel,
} from "./derive";
import type { ActivityRow, FeedRow } from "./types";

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: "a1",
    issueId: "i1",
    action: "issue.statusChanged",
    actorType: "user",
    actorId: "u1",
    payload: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("parseAction", () => {
  it("splits dotted actions", () => {
    expect(parseAction("issue.statusChanged")).toEqual({ category: "issue", verb: "statusChanged" });
  });
  it("handles actions without a dot", () => {
    expect(parseAction("dependencyChanged")).toEqual({ category: "dependencyChanged", verb: "" });
  });
});

describe("eventStage", () => {
  it("maps a status transition to the stage it moved into", () => {
    expect(eventStage(row({ payload: { to: "developed" } }))).toBe("code");
    expect(eventStage(row({ payload: { to: "released" } }))).toBe("release");
    expect(eventStage(row({ payload: { to: "approved" } }))).toBe("plan");
  });
  it("falls back to the action category hue", () => {
    expect(eventStage(row({ action: "comment.created", payload: null }))).toBe("review");
  });
  it("returns null for an unknown category with no status payload", () => {
    expect(eventStage(row({ action: "mystery.thing", payload: null }))).toBeNull();
  });
});

describe("verbLabel + detailLine", () => {
  it("labels known verbs", () => {
    expect(verbLabel(row({ action: "comment.created" }))).toBe("Commented");
    expect(verbLabel(row({ action: "issue.statusChanged" }))).toBe("Status changed");
  });
  it("renders a from → to detail for status changes", () => {
    expect(detailLine(row({ payload: { from: "open", to: "confirmed" } }))).toBe("open → confirmed");
  });
  it("has no detail when payload is empty", () => {
    expect(detailLine(row({ payload: null }))).toBeNull();
  });
});

describe("relativeTime", () => {
  it("formats seconds/minutes ago", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(new Date(now - 5_000).toISOString(), now)).toBe("5s ago");
    expect(relativeTime(new Date(now - 120_000).toISOString(), now)).toBe("2m ago");
  });
});

describe("todayStats", () => {
  it("counts today's events by stage", () => {
    const now = Date.now();
    const rows: FeedRow[] = [
      { ...row({ payload: { to: "developed" } }), projectId: "p", projectName: "P" },
      { ...row({ payload: { to: "developed" } }), projectId: "p", projectName: "P" },
      { ...row({ action: "comment.created", payload: null }), projectId: "p", projectName: "P" },
    ];
    const stats = todayStats(rows, now);
    expect(stats.total).toBe(3);
    expect(stats.byStage.find((s) => s.stage === "code")?.count).toBe(2);
    expect(stats.byStage.find((s) => s.stage === "review")?.count).toBe(1);
  });
});
