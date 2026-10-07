// The bell lists the rows its badge counts (ISS-289, FB-92, FB-76): it asks core for open rows only,
// newest first, a page at a time, and offers the next page until every open row is reachable, so the
// rows it can show equal the open count on the badge. History of any state is a link away.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { NotificationRow } from "../types";
import { NotificationsBell } from "./notifications-bell";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../use-notification-delivery", () => ({ useNotificationDelivery: () => undefined }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

interface Stored {
  row: NotificationRow;
  open: boolean;
}

let seq = 0;
function delivery(open: boolean, over: Partial<NotificationRow> = {}): Stored {
  seq += 1;
  const id = `d-${String(seq).padStart(3, "0")}`;
  return {
    open,
    row: {
      id,
      notificationId: `n-${id}`,
      projectId: null,
      type: open ? "issue_stranded" : "issue_status_changed",
      kind: open ? "condition" : "signal",
      tier: open ? "ticket" : "log",
      title: id,
      body: null,
      readAt: open ? null : "2026-10-07T00:00:00Z",
      groupKey: null,
      resolvedNotice: false,
      members: 1,
      openMembers: open ? 1 : 0,
      severity: "warning",
      issueId: null,
      secondaryIssueId: null,
      agentSessionId: null,
      createdAt: "2026-10-07T00:00:00Z",
      subject: null,
      project: null,
      line: `${open ? "open" : "past"} ${id}`,
      ...over,
    },
  };
}

const many = (n: number, open: boolean) => Array.from({ length: n }, () => delivery(open));

/**
 * Core over `fetch`, holding `store` newest first: `GET /notifications` filters on `openOnly` and
 * pages the way `deliveries-read.ts:listDeliveries` does, and the open count is what the badge reads.
 */
function core(store: Stored[]) {
  const openCount = store.filter((s) => s.open).length;
  const calls = fakeCore((call) => {
    const url = new URL(call.path, "http://forge.test");
    if (url.pathname === "/notifications/open-count") return { body: { count: openCount } };
    if (url.pathname === "/notifications" && call.method === "GET") {
      const openOnly = url.searchParams.get("openOnly") === "true";
      const page = Number(url.searchParams.get("page") ?? "1");
      const size = Number(url.searchParams.get("pageSize") ?? "25");
      const pool = store.filter((s) => !openOnly || s.open).map((s) => s.row);
      return { body: { items: pool.slice((page - 1) * size, page * size), total: pool.length } };
    }
    if (url.pathname === "/projects") return { body: [] };
    if (url.pathname === "/invitations/pending") return { body: [] };
    return undefined;
  });
  return { calls, openCount };
}

function renderBell() {
  const anchor = { current: document.body.appendChild(document.createElement("button")) };
  const onClose = vi.fn();
  renderWithQuery(<NotificationsBell open onClose={onClose} anchor={anchor} />);
  return { onClose };
}

const rowTexts = () => screen.queryAllByTestId("notification-row").map((r) => r.textContent ?? "");
const moreButton = () => screen.queryByRole("button", { name: /^Show \d+ more/ });

/** Press "Show N more" until the bell offers no more, as a reader scrolling to the end would. */
async function revealAll() {
  for (let guard = 0; guard < 10; guard++) {
    const more = moreButton();
    if (!more) return;
    const before = rowTexts().length;
    fireEvent.click(more);
    await waitFor(() => expect(rowTexts().length).toBeGreaterThan(before));
  }
  throw new Error("the bell kept offering more after 10 pages");
}

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("the notifications bell", () => {
  it("asks core for open rows only", async () => {
    const { calls } = core([...many(2, true)]);
    renderBell();
    await waitFor(() => expect(rowTexts()).toHaveLength(2));
    const lists = calls.filter((c) => c.path.startsWith("/notifications?"));
    expect(lists.length).toBeGreaterThan(0);
    for (const c of lists) expect(new URL(c.path, "http://forge.test").searchParams.get("openOnly")).toBe("true");
  });

  it("reads all caught up with no open row, however many newer rows are past", async () => {
    core([...many(5, false)]);
    renderBell();
    await waitFor(() => expect(screen.getByText("You're all caught up")).toBeInTheDocument());
    expect(rowTexts()).toEqual([]);
    expect(moreButton()).toBeNull();
  });

  it("lists exactly twenty open rows on one page and offers no more", async () => {
    const { openCount } = core([...many(3, false), ...many(20, true)]);
    renderBell();
    await waitFor(() => expect(rowTexts()).toHaveLength(20));
    expect(moreButton()).toBeNull();
    expect(rowTexts()).toHaveLength(openCount);
    expect(rowTexts().every((t) => t.includes("open d-"))).toBe(true);
  });

  it("reaches the twenty-first open row behind newer rows that are no longer open", async () => {
    // one open row newest, 25 read signals after it, 20 older open rows behind them
    const { openCount } = core([delivery(true), ...many(25, false), ...many(20, true)]);
    renderBell();
    await waitFor(() => expect(rowTexts()).toHaveLength(20));
    expect(moreButton()).toHaveTextContent("Show 1 more");
    await revealAll();
    expect(moreButton()).toBeNull();
    expect(openCount).toBe(21);
    expect(rowTexts()).toHaveLength(openCount);
    expect(rowTexts().every((t) => t.includes("open d-"))).toBe(true);
  });

  it("pages through fifty-one open rows, saying how many are not shown, until the list holds them all", async () => {
    const { openCount } = core([...many(10, false), ...many(51, true)]);
    renderBell();
    await waitFor(() => expect(rowTexts()).toHaveLength(20));
    expect(moreButton()).toHaveTextContent("Show 20 more · 31 not shown");
    await revealAll();
    expect(rowTexts()).toHaveLength(openCount);
    expect(new Set(rowTexts()).size).toBe(51);
  });

  it("lists an open row the reader has already read", async () => {
    core([delivery(true, { readAt: "2026-10-07T00:00:00Z", line: "open read" }), ...many(3, false)]);
    renderBell();
    await waitFor(() => expect(rowTexts()).toHaveLength(1));
    expect(rowTexts()[0]).toContain("open read");
  });

  it("opens every notification of any state in Settings, and closes", async () => {
    core([...many(1, true)]);
    const { onClose } = renderBell();
    await waitFor(() => expect(rowTexts()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "All notifications" }));
    expect(push).toHaveBeenCalledWith("/settings?tab=notifications");
    expect(onClose).toHaveBeenCalled();
  });
});
