import { describe, expect, it } from "vitest";
import { toNotificationItem } from "./map";
import type { NotificationRow } from "./types";

function row(over: Partial<NotificationRow>): NotificationRow {
  return {
    id: "n1",
    userId: "u1",
    projectId: "p1",
    type: "issue_status_changed",
    title: "ISS-1 moved to developed",
    body: null,
    read: false,
    severity: null,
    resolutionKey: null,
    resolvedAt: null,
    issueId: "i1",
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
    const item = toNotificationItem(row({ read: false, body: "Reopened — needs a look." }));
    expect(item.unread).toBe(true);
    expect(item.sub).toBe("Reopened — needs a look.");
  });
});
