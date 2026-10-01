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
