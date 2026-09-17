import { describe, expect, it } from "vitest";
import { toNotificationItem } from "./map";
import type { NotificationRow } from "./types";

function row(over: Partial<NotificationRow>): NotificationRow {
  return {
    id: "d1",
    notificationId: "n1",
    projectId: "p1",
    type: "issue_status_changed",
    kind: "signal",
    tier: "log",
    title: "ISS-1 moved to developed",
    body: null,
    readAt: null,
    groupKey: null,
    resolvedNotice: false,
    members: 1,
    openMembers: 0,
    severity: null,
    issueId: "i1",
    secondaryIssueId: null,
    agentSessionId: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("toNotificationItem hue (ISS-510)", () => {
  it("derives hue from explicit severity", () => {
    expect(toNotificationItem(row({ severity: "error" })).hue).toBe("red");
    expect(toNotificationItem(row({ severity: "warning" })).hue).toBe("amber");
    expect(toNotificationItem(row({ severity: "success" })).hue).toBe("green");
    expect(toNotificationItem(row({ severity: "info" })).hue).toBe("cobalt");
  });

  it("severity wins over the legacy title/type sniff", () => {
    // Title says "reopen" (legacy → red) but explicit severity is success.
    const item = toNotificationItem(
      row({ severity: "success", title: "ISS-1 left reopen", type: "issue_status_changed" }),
    );
    expect(item.hue).toBe("green");
  });

  it("falls back to the title/type sniff for legacy rows without severity", () => {
    expect(toNotificationItem(row({ severity: null, type: "pipeline_wedge" })).hue).toBe("red");
    expect(
      toNotificationItem(row({ severity: null, title: "ISS-2 moved to waiting" })).hue,
    ).toBe("amber");
    expect(
      toNotificationItem(row({ severity: null, title: "ISS-3 moved to closed" })).hue,
    ).toBe("green");
    expect(
      toNotificationItem(row({ severity: null, title: "ISS-4 moved to developed" })).hue,
    ).toBe("cobalt");
  });

  it("maps the unread flag and carries the body as sub", () => {
    const item = toNotificationItem(row({ readAt: null, body: "Reopened — needs a look." }));
    expect(item.unread).toBe(true);
    expect(item.sub).toBe("Reopened — needs a look.");
  });

  // ISS-1063 — the two halves the old `read` boolean conflated.
  it("reads the delivery's read state, not the record's", () => {
    expect(toNotificationItem(row({ readAt: new Date().toISOString() })).unread).toBe(false);
    expect(toNotificationItem(row({ readAt: null })).unread).toBe(true);
  });

  it("a delivery carrying one record is not a group", () => {
    expect(toNotificationItem(row({ members: 1, openMembers: 1 })).group).toBeUndefined();
  });

  it("a grouped delivery carries how many it holds and how many are still true", () => {
    const item = toNotificationItem(row({ members: 15, openMembers: 12 }));
    expect(item.group).toEqual({ total: 15, open: 12 });
  });

  it("a resolved notice is labelled as one rather than as its type", () => {
    expect(toNotificationItem(row({ resolvedNotice: true })).label).toBe("RESOLVED");
  });
});
