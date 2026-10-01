// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationRow } from "../types";

expect.extend(matchers);

const STALE =
  "A rfi this project wrote is held at the approve gate until an admin approves or returns it.";

function row(over: Partial<NotificationRow>): NotificationRow {
  return {
    id: "d1",
    notificationId: "n1",
    projectId: "p1",
    type: "channel_gate_pending",
    kind: "task",
    title: "QE-RFI-1 waits for your approval: a question",
    body: STALE,
    readAt: null,
    members: 1,
    openMembers: 1,
    resolvedNotice: false,
    issueId: null,
    agentSessionId: null,
    createdAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

let rows: NotificationRow[] = [];
vi.mock("../hooks", () => ({
  useNotifications: () => ({
    data: { items: rows, totalCount: rows.length },
    isLoading: false,
    isError: false,
  }),
  useMarkAllRead: () => ({ mutate: vi.fn(), isPending: false }),
  usePreferences: () => ({ data: undefined, isLoading: false, isError: false }),
  useUpdatePreferences: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { NotificationsTab } from "./notifications-tab";

afterEach(cleanup);

describe("the notifications list, once a gate was decided", () => {
  it("shows neither the cleared delivery's nor the resolved notice's stale body", () => {
    const resolved = "Resolved — QE-RFI-1 approved by Ada and published as QE-RFI-1: a question";
    rows = [
      row({ id: "notice", title: resolved, resolvedNotice: true, openMembers: 0, readAt: "x" }),
      row({ id: "told", openMembers: 0 }),
    ];
    render(<NotificationsTab />);
    expect(screen.getByText(resolved)).toBeInTheDocument();
    expect(screen.queryByText(STALE)).not.toBeInTheDocument();
  });

  it("shows the body while the gate still waits", () => {
    rows = [row({})];
    render(<NotificationsTab />);
    expect(screen.getByText(STALE)).toBeInTheDocument();
  });
});
