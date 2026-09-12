// @vitest-environment jsdom
//
// ISS-982 — the picker offers the moves the rung has. The cases below are the
// four states the registry read can be in, on each of the three surfaces that
// render a status target: a menu that cannot say which of them it is in is the
// defect, not merely a missing feature.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ToastProvider } from "@/providers/toast-provider";
import { BulkActionBar } from "./bulk-action-bar";
import { IssueMobileCard } from "./issue-row-actions";
import { StatusEdit } from "./inline-edit-cell";
import type { IssueRow, IssueStatus } from "../types";

expect.extend(matchers);

const get = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("../registry-api", () => ({
  registryApi: { get: () => get() },
}));

vi.mock("../hooks", async () => {
  const actual = await vi.importActual<typeof import("../hooks")>("../hooks");
  return { ...actual, useBulkUpdateIssues: () => ({ mutate: vi.fn(), isPending: false }) };
});

const STATUS_EXITS = {
  open: ["confirmed", "in_progress", "needs_info", "on_hold", "dropped"],
  in_progress: ["developed", "closed", "needs_info", "on_hold", "dropped"],
  closed: ["reopen"],
  dropped: [],
} as const;

const ANSWERED = {
  version: 7,
  runnerCapabilities: { "claude-code": ["drive"] },
  statusExits: STATUS_EXITS,
};

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

function openPicker(status: IssueStatus) {
  wrap(<StatusEdit status={status} onTransition={vi.fn()} />);
  fireEvent.click(screen.getByLabelText(`Change status (currently ${status})`));
}

function labels(): string[] {
  return screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
}

const row = (over: Partial<IssueRow>): IssueRow =>
  ({ id: "i1", issueId: "ISS-1", displayId: "ISS-1", title: "t", status: "open", priority: "medium", ...over }) as IssueRow;

afterEach(() => {
  cleanup();
  get.mockReset();
});

describe("StatusEdit, once the exits have answered", () => {
  it("offers a closed issue only Reopen", async () => {
    get.mockResolvedValue(ANSWERED);
    openPicker("closed");
    await screen.findByText("Reopened");
    expect(labels()).toEqual(["Reopened"]);
  });

  it("tells a dropped issue it is re-filed rather than reopened", async () => {
    get.mockResolvedValue(ANSWERED);
    openPicker("dropped");
    await screen.findByText(/re-file instead/);
    expect(labels()).toHaveLength(1);
    expect(screen.getByRole("menuitem")).toHaveAttribute("aria-disabled", "true");
  });

  // cm:guard focus MUST enter the panel on a rung whose every row is inert — the panel owns the key handler, so a menu that leaves focus on the trigger cannot be escaped and never announces what it opened to say. Plant it by asserting the trigger is NOT the active element (ISS-982)
  it("puts focus on the inert row, and Escape still closes the menu", async () => {
    get.mockResolvedValue(ANSWERED);
    openPicker("dropped");
    const rowItem = await screen.findByRole("menuitem");
    expect(document.activeElement).toBe(rowItem);
    fireEvent.keyDown(rowItem, { key: "Escape" });
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("does nothing when an inert row is activated", async () => {
    const onTransition = vi.fn();
    get.mockResolvedValue(ANSWERED);
    wrap(<StatusEdit status="dropped" onTransition={onTransition} />);
    fireEvent.click(screen.getByLabelText("Change status (currently dropped)"));
    fireEvent.click(await screen.findByRole("menuitem"));
    expect(onTransition).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem")).toBeInTheDocument();
  });

  it("puts the forward rung first and the discards last", async () => {
    get.mockResolvedValue(ANSWERED);
    openPicker("in_progress");
    await screen.findByRole("menuitem", { name: "Paused" });
    expect(labels()).toEqual(["Running", "Needs a human", "Paused", "Done", "Dropped"]);
  });

  // cm:guard the autonomous vocabulary is many-to-one, so a narrowed menu can offer the same word twice — `open` exits to both `confirmed` and `in_progress` and both read "Running". Two identical rows IS the menu at that rung (ISS-982).
  it("carries the kernel status where one label would appear twice", async () => {
    get.mockResolvedValue(ANSWERED);
    openPicker("open");
    await screen.findByText("Running (confirmed)");
    expect(labels()).toEqual([
      "Running (confirmed)",
      "Running (in progress)",
      "Needs a human",
      "Paused",
      "Dropped",
    ]);
  });

  it("offers no retired status", async () => {
    get.mockResolvedValue(ANSWERED);
    openPicker("open");
    await screen.findByText("Running (confirmed)");
    for (const retired of ["Clarified", "Waiting", "Tested"]) {
      expect(screen.queryByText(retired)).toBeNull();
    }
  });
});

describe("StatusEdit, before the exits have answered", () => {
  it("says the moves are loading while the read is in flight", () => {
    get.mockReturnValue(new Promise(() => {}));
    openPicker("open");
    expect(labels()).toEqual(["Loading status moves…"]);
    expect(screen.getByRole("menuitem")).toHaveAttribute("aria-disabled", "true");
  });

  // cm:guard assert the LOADING line first and the failure line after it: a case that only waits for the failure text passes just as well against code that shows it while the read is still in flight, which is the substitution ISS-982's criteria 12 and 14 were split apart to catch
  it("says the moves could not be loaded once the read has failed", async () => {
    get.mockRejectedValue(new Error("offline"));
    openPicker("open");
    expect(labels()).toEqual(["Loading status moves…"]);
    await screen.findByText("Couldn't load status moves");
    expect(labels()).toEqual(["Couldn't load status moves"]);
  });

  // cm:guard a core that predates `statusExits` must land here and NOT in the answered branch — the field is optional precisely so the two halves deploy in either order, and an answered-but-absent map rendered as "no moves from this rung" would read as a terminal issue (ISS-982)
  it("treats an answer carrying no statusExits as a failed read", async () => {
    get.mockResolvedValue({ version: 6, runnerCapabilities: { "claude-code": ["drive"] } });
    openPicker("open");
    expect(labels()).toEqual(["Loading status moves…"]);
    await screen.findByText("Couldn't load status moves");
    expect(labels()).toEqual(["Couldn't load status moves"]);
  });
});

describe("BulkActionBar", () => {
  function bulk(rows: IssueRow[]) {
    wrap(<BulkActionBar projectId="p1" selectedRows={rows} onCleared={vi.fn()} />);
    return () => screen.getByRole("button", { name: /Set status/ });
  }

  // cm:guard every one of the three refusals is asserted as RENDERED TEXT and as the button's accessible description — a `title` assertion passes against a reason no keyboard or touch user can reach, which is the shape this control shipped in (ISS-982)
  const describedBy = (el: HTMLElement) =>
    document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent;

  it("disables Set status while the exits are unread, saying so", () => {
    get.mockReturnValue(new Promise(() => {}));
    const btn = bulk([row({ status: "open" })]);
    expect(btn()).toBeDisabled();
    expect(screen.getByText("Loading the status moves…")).toBeInTheDocument();
    expect(describedBy(btn())).toBe("Loading the status moves…");
  });

  it("disables Set status once the read has failed, saying so", async () => {
    get.mockRejectedValue(new Error("offline"));
    const btn = bulk([row({ status: "open" })]);
    await screen.findByText("Couldn't load the status moves");
    expect(btn()).toBeDisabled();
    expect(describedBy(btn())).toBe("Couldn't load the status moves");
  });

  // cm:guard the two disabled reasons must stay distinct: one says come back in a moment, the other says re-pick the selection
  it("names the empty intersection differently from an unread read", async () => {
    get.mockResolvedValue(ANSWERED);
    const btn = bulk([row({ status: "dropped" }), row({ id: "i2", status: "open" })]);
    await screen.findByText("No status change is valid for every selected issue");
    expect(describedBy(btn())).toBe("No status change is valid for every selected issue");
    expect(screen.queryByText("Loading the status moves…")).toBeNull();
  });

  it("offers the intersection once the exits have answered", async () => {
    get.mockResolvedValue(ANSWERED);
    const btn = bulk([row({ status: "open" }), row({ id: "i2", status: "in_progress" })]);
    await vi.waitFor(() => expect(btn()).not.toBeDisabled());
    fireEvent.click(btn());
    expect(labels()).toEqual(["Paused", "Dropped"]);
  });
});

// cm:guard the row overflow menu is the THIRD surface criteria 18-21 name and the only one that renders status moves beside unrelated items — proving the picker and the bulk bar leaves it read off the other two, which is how it shipped untested (ISS-982)
describe("row overflow menu", () => {
  const actions = { patch: vi.fn(), transition: vi.fn(), isPending: false };

  function openRowMenu(status: IssueStatus) {
    wrap(
      <IssueMobileCard row={row({ status })} slug="p1" actions={actions} />,
    );
    fireEvent.click(screen.getByLabelText("Row actions"));
  }

  const statusItems = () =>
    labels().filter((l) => l.startsWith("Status: ") || l.includes("status moves"));

  it("offers no status target while the read is in flight, and says the moves are loading", () => {
    get.mockReturnValue(new Promise(() => {}));
    openRowMenu("open");
    expect(statusItems()).toEqual(["Loading status moves…"]);
  });

  it("offers no status target once the read has failed, and says so", async () => {
    get.mockRejectedValue(new Error("offline"));
    openRowMenu("open");
    expect(statusItems()).toEqual(["Loading status moves…"]);
    await screen.findByText("Couldn't load status moves");
    expect(statusItems()).toEqual(["Couldn't load status moves"]);
  });

  it("offers the rung's own row once the read has answered", async () => {
    get.mockResolvedValue(ANSWERED);
    openRowMenu("closed");
    await screen.findByText("Status: Reopened");
    expect(statusItems()).toEqual(["Status: Reopened"]);
  });

  it("offers a dropped row no status item at all", async () => {
    get.mockResolvedValue(ANSWERED);
    openRowMenu("dropped");
    expect(statusItems()).toEqual(["Loading status moves…"]);
    await vi.waitFor(() => expect(statusItems()).toEqual([]));
  });
});
