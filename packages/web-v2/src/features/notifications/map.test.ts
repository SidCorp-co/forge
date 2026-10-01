import { describe, expect, it } from "vitest";
import { deliveryResolved, toNotificationItem } from "./map";
import type { NotificationRow } from "./types";

function row(over: Partial<NotificationRow>): NotificationRow {
  return {
    id: "d1",
    notificationId: "n1",
    projectId: "p1",
    type: "channel_gate_pending",
    kind: "task",
    tier: "ticket",
    title: "QE-RFI-1 waits for your approval: a question",
    body: null,
    readAt: null,
    groupKey: null,
    resolvedNotice: false,
    members: 1,
    openMembers: 1,
    severity: "warning",
    issueId: null,
    secondaryIssueId: null,
    agentSessionId: null,
    createdAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

describe("the delivery that told of a gate or a hold, once it cleared", () => {
  it("reads as resolved, not as an unread approval still waiting", () => {
    const item = toNotificationItem(row({ openMembers: 0 }));
    expect(item).toMatchObject({ label: "RESOLVED", unread: false, hue: "green" });
  });

  it("reads as resolved for a condition, a hold released", () => {
    const held = row({ type: "channel_thread_held", kind: "condition", openMembers: 0 });
    expect(toNotificationItem(held)).toMatchObject({ label: "RESOLVED", unread: false });
  });

  it("still reads as waiting while the gate is open", () => {
    expect(toNotificationItem(row({}))).toMatchObject({ label: "APPROVE", unread: true });
  });

  it("never calls a signal resolved, since an event cannot stop having happened", () => {
    const signal = row({ type: "mention", kind: "signal", openMembers: 0 });
    expect(deliveryResolved(signal)).toBe(false);
    expect(toNotificationItem(signal)).toMatchObject({ label: "MENTION", unread: true });
  });
});

describe("a resolved row never shows the body that described it while it waited", () => {
  const stale =
    "A rfi this project wrote is held at the approve gate until an admin approves or returns it.";

  it("drops the body from the delivery that told of the gate, once it cleared", () => {
    const item = toNotificationItem(row({ body: stale, openMembers: 0 }));
    expect(item.text).toBe("QE-RFI-1 waits for your approval: a question");
    expect(item.sub).toBeUndefined();
  });

  it("drops the body from the resolved notice, which keeps its own title", () => {
    const title = "Resolved — QE-RFI-1 approved by Ada and published as QE-RFI-1: a question";
    const item = toNotificationItem(row({ title, body: stale, resolvedNotice: true, openMembers: 0 }));
    expect(item).toMatchObject({ label: "RESOLVED", text: title });
    expect(item.sub).toBeUndefined();
  });

  it("keeps the body while the gate still waits", () => {
    expect(toNotificationItem(row({ body: stale })).sub).toBe(stale);
  });

  it("keeps a signal's body, since a signal is never resolved", () => {
    const signal = row({ type: "mention", kind: "signal", body: "you were mentioned", openMembers: 0 });
    expect(toNotificationItem(signal).sub).toBe("you were mentioned");
  });
});
