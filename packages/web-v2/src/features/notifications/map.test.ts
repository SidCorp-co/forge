// A bell row as the reader sees it: resolved or still waiting, unread or not, and which project and
// entity it names — each from core's fields, never parsed from the text.

import { describe, expect, it } from "vitest";
import { deliveryResolved, toNotificationItem } from "./map";
import type { NotificationRow } from "./types";

function row(over: Partial<NotificationRow>): NotificationRow {
  return {
    id: "d1",
    notificationId: "n1",
    projectId: "p1",
    type: "issue_stranded",
    kind: "condition",
    tier: "ticket",
    title: "ISS-12 is waiting on you",
    body: null,
    readAt: null,
    groupKey: null,
    resolvedNotice: false,
    members: 1,
    openMembers: 1,
    severity: "warning",
    issueId: "i1",
    secondaryIssueId: null,
    agentSessionId: null,
    createdAt: "2026-10-01T00:00:00Z",
    subject: { kind: "issue", key: "ISS-12", id: "i1" },
    project: { slug: "hop", name: "HOP" },
    line: "is waiting on you",
    ...over,
  };
}

describe("a row that is still true", () => {
  it("reads unread and waiting, in its severity's hue", () => {
    expect(toNotificationItem(row({}))).toMatchObject({ resolved: false, unread: true, hue: "amber" });
  });

  it("reads read once the reader opened it", () => {
    expect(toNotificationItem(row({ readAt: "2026-10-01T01:00:00Z" })).unread).toBe(false);
  });
});

describe("a row whose every record cleared", () => {
  it("reads resolved, green and without the unread dot", () => {
    expect(toNotificationItem(row({ openMembers: 0 }))).toMatchObject({ resolved: true, unread: false, hue: "green" });
  });

  it("drops the body that described it while it waited", () => {
    expect(toNotificationItem(row({ body: "Parked since Monday", openMembers: 0 })).sub).toBeUndefined();
    expect(toNotificationItem(row({ body: "Parked since Monday" })).sub).toBe("Parked since Monday");
  });
});

describe("the notice that a condition cleared (FB-76)", () => {
  const notice = row({
    title: "Resolved — ISS-12 is moving again",
    line: "is moving again",
    resolvedNotice: true,
    openMembers: 0,
    body: "Parked since Monday",
  });

  it("reads resolved and carries no unread dot, as the row it resolves does not", () => {
    expect(toNotificationItem(notice)).toMatchObject({ resolved: true, unread: false });
  });

  it("drops the body written while the condition held", () => {
    expect(toNotificationItem(notice).sub).toBeUndefined();
  });
});

describe("a signal", () => {
  it("is never resolved, since an event cannot stop having happened", () => {
    const signal = row({ type: "mention", kind: "signal", openMembers: 0, body: "you were mentioned" });
    expect(deliveryResolved(signal)).toBe(false);
    expect(toNotificationItem(signal)).toMatchObject({ resolved: false, unread: true, sub: "you were mentioned" });
  });
});

describe("what a row names", () => {
  it("names the entity key and the project it sits in", () => {
    expect(toNotificationItem(row({}))).toMatchObject({ subjectKey: "ISS-12", project: "HOP" });
  });

  it("does not repeat the project when the project is the subject", () => {
    const item = toNotificationItem(row({ subject: { kind: "project", key: "hop", id: "p1" } }));
    expect(item.subjectKey).toBe("hop");
    expect(item.project).toBeUndefined();
  });

  it("folds a grouped delivery into one row naming how many of its records are open", () => {
    expect(toNotificationItem(row({ members: 15, openMembers: 3 })).group).toEqual({ total: 15, open: 3 });
    expect(toNotificationItem(row({})).group).toBeUndefined();
  });
});
