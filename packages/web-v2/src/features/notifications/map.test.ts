import { NOTIFICATION_TYPES } from "@forge/contracts/notifications";
import { describe, expect, it } from "vitest";
import { TYPE_FILTER_OPTIONS, TYPE_NAMES, toNotificationItem } from "./map";
import type { NotificationRow } from "./types";

const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: "d1",
  notificationId: "n1",
  projectId: "p1",
  type: "issue_stranded",
  kind: "condition",
  tier: "ticket",
  title: "ISS-1 is parked",
  body: null,
  explanation: null,
  readAt: null,
  unread: true,
  groupKey: null,
  resolvedNotice: false,
  members: 1,
  openMembers: 1,
  severity: "warning",
  projectSlug: "invoicing",
  projectName: "Invoicing",
  issueId: "i1",
  secondaryIssueId: null,
  agentSessionId: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

describe("the type filter", () => {
  it("names every type the contract lists, once, and no other", () => {
    expect(TYPE_FILTER_OPTIONS.map((o) => o.value)).toEqual([...NOTIFICATION_TYPES]);
    expect(new Set(TYPE_FILTER_OPTIONS.map((o) => o.label)).size).toBe(NOTIFICATION_TYPES.length);
    expect(Object.keys(TYPE_NAMES).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });
});

describe("toNotificationItem", () => {
  it("reads unread off the server's state, not off the read stamp", () => {
    expect(toNotificationItem(row({ unread: false, readAt: null })).unread).toBe(false);
    expect(toNotificationItem(row({ unread: true, readAt: "2026-10-01T11:00:00.000Z" })).unread).toBe(true);
  });

  it("labels a resolved notice as resolved and a several-record row as a group", () => {
    expect(toNotificationItem(row({ resolvedNotice: true })).label).toBe("RESOLVED");
    expect(toNotificationItem(row({ members: 4, openMembers: 3 })).group).toEqual({ total: 4, open: 3 });
    expect(toNotificationItem(row()).group).toBeUndefined();
  });
});
