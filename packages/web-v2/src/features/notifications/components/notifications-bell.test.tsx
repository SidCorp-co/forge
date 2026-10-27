// @vitest-environment jsdom
//
// ISS-1168 r2 — the bell reads the way the inbox does: opening a group reads nothing, following a
// record reads the delivery it belongs to, and a group spanning two projects names each record's own.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationMember, NotificationRow } from "../types";

expect.extend(matchers);

const state = vi.hoisted(() => ({
  rows: [] as NotificationRow[],
  members: [] as NotificationMember[],
  marked: [] as string[],
  pushed: [] as string[],
  membersFail: false,
  membersRead: 0,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (h: string) => state.pushed.push(h) }) }));
vi.mock("@/features/projects/hooks", () => ({ useProjects: () => ({ data: [] }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("../use-notification-delivery", () => ({ useNotificationDelivery: () => {} }));
vi.mock("../use-open-indicator", () => ({ useOpenIndicator: () => {} }));
vi.mock("../hooks", () => {
  const idle = { mutate: () => {}, isPending: false, variables: undefined };
  return {
    useNotifications: () => ({
      data: { items: state.rows },
      isLoading: false,
      isError: false,
      refetch: () => {},
    }),
    useNotificationMembers: (id: string | null) =>
      state.membersFail && id
        ? {
            data: undefined,
            isLoading: false,
            isError: true,
            error: new Error("The server is down."),
            refetch: () => {
              state.membersRead += 1;
            },
          }
        : { data: id ? state.members : undefined, isLoading: false, isError: false, error: null, refetch: () => {} },
    useOpenCount: () => ({ data: { count: 1 } }),
    useMarkRead: () => ({ ...idle, mutate: (id: string) => state.marked.push(id) }),
    useMarkAllRead: () => idle,
    usePendingInvitations: () => ({ data: [], isLoading: false, isError: false, refetch: () => {} }),
    useAcceptInvitation: () => idle,
    useDeclineInvitation: () => idle,
  };
});

import { formatRelativeTime } from "@/lib/utils/format";
import { NotificationsBell } from "./notifications-bell";

const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: "d1",
  notificationId: "x1",
  projectId: null,
  type: "issue_stranded",
  kind: "condition",
  tier: "ticket",
  title: "Issues whose code shipped and whose close was never written",
  body: null,
  explanation: null,
  readAt: null,
  unread: true,
  groupKey: "sweep:owed-close:1",
  resolvedNotice: false,
  members: 3,
  openMembers: 3,
  severity: null,
  projectSlug: null,
  projectName: null,
  issueId: null,
  secondaryIssueId: null,
  agentSessionId: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  toldAt: "2026-10-01T10:00:00.000Z",
  stuckKind: "owed_close",
  ...over,
});

const member = (n: number, over: Partial<NotificationMember> = {}): NotificationMember => ({
  id: `m${n}`,
  type: "issue_stranded",
  kind: "condition",
  state: "firing",
  title: `ISS-${n} shipped but never closed`,
  body: null,
  severity: null,
  projectId: "p1",
  projectSlug: "invoicing",
  projectName: "Invoicing",
  issueId: `00000000-0000-4000-8000-00000000000${n}`,
  secondaryIssueId: null,
  resolvedAt: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  deliveredAt: "2026-10-01T10:00:00.000Z",
  open: true,
  ...over,
});

function mount() {
  const anchor = { current: document.body };
  return render(<NotificationsBell open onClose={() => {}} anchor={anchor} />);
}

beforeEach(() => {
  state.rows = [row()];
  state.members = [];
  state.marked = [];
  state.pushed = [];
  state.membersFail = false;
  state.membersRead = 0;
});
afterEach(cleanup);

describe("a grouped row in the bell", () => {
  it("opens to its members and reads nothing, however it is opened", () => {
    mount();
    fireEvent.click(screen.getByText("Issues whose code shipped and whose close was never written"));
    expect(screen.getByRole("button", { name: "3 still open — hide" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "3 still open — hide" }));
    fireEvent.click(screen.getByRole("button", { name: "3 still open — show" }));
    expect(state.marked).toEqual([]);
  });

  it("reads the delivery when a member is followed, and opens that member's issue", () => {
    state.members = [member(1)];
    mount();
    fireEvent.click(screen.getByRole("button", { name: "3 still open — show" }));
    fireEvent.click(screen.getByRole("button", { name: /^ISS-1 shipped but never closed/ }));
    expect(state.marked).toEqual(["d1"]);
    expect(state.pushed).toEqual(["/projects/invoicing/issues/00000000-0000-4000-8000-000000000001"]);
  });

  // ISS-1229 r13, judge-30: an expanded member showed only its title, so "parked for 6 hours" was never
  // read in the bell.
  it("shows each member's own sentence under its title", () => {
    state.members = [member(1, { body: 'ISS-1 "Repair export": it has been parked for 6 hours.' })];
    mount();
    fireEvent.click(screen.getByRole("button", { name: "3 still open — show" }));
    expect(screen.getByText('ISS-1 "Repair export": it has been parked for 6 hours.')).toBeInTheDocument();
  });

  // ISS-1229 r13, judge-30: the group read "1m ago" while its members read "3m ago" — the group by when
  // it reached the reader, each member by when its condition was first seen pending.
  it("reads the group and its members on one clock: when each reached the reader", () => {
    const told = new Date(Date.now() - 60_000).toISOString();
    const seenPending = new Date(Date.now() - 3 * 3_600_000).toISOString();
    state.rows = [row({ createdAt: told, toldAt: told })];
    state.members = [member(1, { createdAt: seenPending, deliveredAt: told })];
    mount();
    fireEvent.click(screen.getByRole("button", { name: "3 still open — show" }));
    const memberButton = screen.getByRole("button", { name: /^ISS-1 shipped but never closed/ });
    expect(memberButton.textContent).toContain(formatRelativeTime(told));
    expect(memberButton.textContent).not.toContain(formatRelativeTime(seenPending));
  });

  it("names the project on each record where the group spans two, so ISS-1 and ISS-1 read apart", () => {
    state.members = [
      member(1),
      member(3),
      member(1, { id: "m9", projectId: "p2", projectSlug: "payroll", projectName: "Payroll" }),
    ];
    mount();
    fireEvent.click(screen.getByRole("button", { name: "3 still open — show" }));
    expect(screen.getByText("Invoicing · ISS-1 shipped but never closed")).toBeInTheDocument();
    expect(screen.getByText("Payroll · ISS-1 shipped but never closed")).toBeInTheDocument();
  });

  it("keeps every control in the menu at least 44px tall", () => {
    state.members = [member(1)];
    mount();
    fireEvent.click(screen.getByRole("button", { name: "3 still open — show" }));
    for (const el of [
      screen.getByRole("button", { name: "Mark all read" }),
      screen.getByRole("button", { name: "3 still open — hide" }),
      screen.getByRole("button", { name: /^ISS-1 shipped but never closed/ }),
    ]) {
      expect(el.className).toContain("min-h-11");
    }
  });
});

describe("a single row in the bell", () => {
  it("is read when it is followed", () => {
    state.rows = [row({ members: 1, openMembers: 1, title: "ISS-5 is stranded", issueId: "i5", projectSlug: "invoicing" })];
    mount();
    fireEvent.click(screen.getByText("ISS-5 is stranded"));
    expect(state.marked).toEqual(["d1"]);
    expect(state.pushed).toEqual(["/projects/invoicing/issues/i5"]);
  });
});

// ISS-1229 r48: a grouped row whose notifications could not be read opened to nothing at all.
describe("a grouped row whose notifications cannot be read", () => {
  it("says they could not be loaded, and Retry reads them again", () => {
    state.membersFail = true;
    mount();
    fireEvent.click(screen.getByText("Issues whose code shipped and whose close was never written"));
    const failure = screen.getByTestId("group-members-unread");
    expect(failure).toHaveTextContent("Couldn't load this group's notifications. The server is down.");
    fireEvent.click(screen.getByRole("button", { name: "Retry this group" }));
    expect(state.membersRead).toBe(1);
  });
});
