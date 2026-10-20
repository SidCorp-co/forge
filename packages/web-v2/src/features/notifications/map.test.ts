import { NOTIFICATION_TYPES } from "@forge/contracts/notifications";
import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "@/lib/utils/format";
import { TYPE_FILTER_OPTIONS, TYPE_NAMES, toInvitationItem, toNotificationItem } from "./map";
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
  toldAt: "2026-10-01T10:00:00.000Z",
  stuckKind: "waiting",
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
  // ISS-1229 r13: a row reads when its newest record reached the reader, the clock its members read.
  it("dates the row by when it last told the reader, not by when the delivery was made", () => {
    const made = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const told = new Date(Date.now() - 60_000).toISOString();
    expect(toNotificationItem(row({ createdAt: made, toldAt: told })).time).toBe(formatRelativeTime(told));
  });

  it("reads unread off the server's state, not off the read stamp", () => {
    expect(toNotificationItem(row({ unread: false, readAt: null })).unread).toBe(false);
    expect(toNotificationItem(row({ unread: true, readAt: "2026-10-01T11:00:00.000Z" })).unread).toBe(true);
  });

  it("labels a resolved notice as resolved and a several-record row as a group", () => {
    expect(toNotificationItem(row({ resolvedNotice: true })).label).toBe("RESOLVED");
    // ISS-1229 r16: a resolved record leaves its group, so the group counts the open ones alone.
    expect(toNotificationItem(row({ members: 4, openMembers: 3 })).group).toEqual({ count: 3, open: true });
    expect(toNotificationItem(row({ members: 4, openMembers: 0 })).group).toBeUndefined();
    expect(toNotificationItem(row({ kind: "signal", members: 4, openMembers: 0 })).group).toEqual({
      count: 4,
      open: false,
    });
    expect(toNotificationItem(row()).group).toBeUndefined();
  });
});

describe("a stuck-issue row whose condition has since resolved (ISS-1229 r12)", () => {
  const cleared = row({
    title: "ISS-3 says work is in progress with no run behind it — qa",
    body: "ISS-3 reads In progress, and nothing has worked it for 13 minutes.",
    unread: false,
    openMembers: 0,
  });

  it("reads as resolved, and says what it said only as what it said when raised", () => {
    const item = toNotificationItem(cleared);
    expect(item.label).toBe("RESOLVED");
    expect(item.hue).toBe("green");
    expect(item.sub).toBe(
      "Since resolved. When it was raised: ISS-3 reads In progress, and nothing has worked it for 13 minutes.",
    );
  });

  it("leaves a stuck-issue row that still holds as it stands", () => {
    const item = toNotificationItem(row({ body: "still stuck" }));
    expect(item.label).toBe("WAITING");
    expect(item.sub).toBe("still stuck");
  });

  it("reads a group whose every record has cleared as resolved too", () => {
    expect(toNotificationItem(row({ members: 3, openMembers: 0, body: null })).label).toBe("RESOLVED");
    expect(toNotificationItem(row({ members: 3, openMembers: 1, body: null })).label).toBe("WAITING");
  });

  // ISS-1229 r15: judge-38 read STRANDED on every stuck group, a word none of their titles says.
  it.each([
    ["waiting", "WAITING", "Issues that have been waiting for a person for over six hours"],
    ["waiting_on_others", "WAITING", "Issues that have been waiting for a person for over six hours"],
    ["idle", "NO LIVE WORK", "Issues that are in a live status with no live work behind them"],
    ["owed_close", "NEVER CLOSED", "Issues that shipped their code and were never closed"],
    ["orphan", "NO RUN", "Issues that assert work in progress with no run behind them"],
  ] as const)("tags a %s group with words its own title says", (stuckKind, tag, title) => {
    const item = toNotificationItem(row({ stuckKind, title, members: 3, openMembers: 3 }));
    expect(item.label).toBe(tag);
    expect(title.toUpperCase()).toContain(tag);
    expect(item.label).not.toBe("STRANDED");
  });

  it("gives a stuck row whose kind has no words of its own no tag at all", () => {
    expect(toNotificationItem(row({ stuckKind: "other" })).label).toBeUndefined();
    expect(toNotificationItem(row({ stuckKind: null })).label).toBeUndefined();
  });

  it("never reads a done task as a resolved condition", () => {
    expect(toNotificationItem(row({ kind: "task", type: "intake_pending", openMembers: 0 })).label).toBe("INTAKE");
  });
});

// ISS-1229 r18, judge-48: the bell named a person by their address; an invitation names its inviter
// by the name core sends, which is never an address.
describe("an invitation row", () => {
  it("names the inviter by the name core sends", () => {
    const item = toInvitationItem(
      {
        kind: "project",
        token: "t1",
        name: "Invoicing",
        inviterName: "Another member",
        role: "member",
        expiresAt: "2026-10-08T10:00:00.000Z",
        createdAt: "2026-10-01T10:00:00.000Z",
      },
      [],
    );
    expect(item.text).toBe("Another member invited you to Invoicing as member");
    expect(item.text).not.toMatch(/@/);
  });
});

// ISS-1228 round 19 (judge-57): the bell tagged a stuck-work notice "WEDGE", a word no person reads.
describe("the bell's tag on a stuck-work notice", () => {
  it("reads STALLED, the type's own word, never WEDGE", () => {
    const item = toNotificationItem(row({ type: "pipeline_wedge", stuckKind: null }));
    expect(JSON.stringify(item)).toContain("STALLED");
    expect(JSON.stringify(item)).not.toContain("WEDGE");
  });
});
