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

function openPicker(status: IssueStatus, agentStatus?: "running" | null) {
  wrap(<StatusEdit status={status} agentStatus={agentStatus} onTransition={vi.fn()} />);
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
    await screen.findByRole("menuitem", { name: "On hold" });
    expect(labels()).toEqual(["Developed", "Needs info", "On hold", "Closed", "Dropped"]);
  });

  // ISS-1213: a target has no holder, so the lane word "Running" would name a move nobody is behind.
  it("names each target by its own status word, never by a lane word", async () => {
    get.mockResolvedValue(ANSWERED);
    openPicker("open");
    await screen.findByText("Confirmed");
    expect(labels()).toEqual(["Confirmed", "In progress", "Needs info", "On hold", "Dropped"]);
    expect(labels().some((l) => /Running|Stalled|No check-in/u.test(l))).toBe(false);
  });

  it("offers no retired status", async () => {
    get.mockResolvedValue(ANSWERED);
    openPicker("open");
    await screen.findByText("Confirmed");
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

  it("says the moves could not be loaded once the read has failed", async () => {
    get.mockRejectedValue(new Error("offline"));
    openPicker("open");
    expect(labels()).toEqual(["Loading status moves…"]);
    await screen.findByText("Couldn't load status moves");
    expect(labels()).toEqual(["Couldn't load status moves"]);
  });

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
    expect(labels()).toEqual(["On hold", "Dropped"]);
  });
});

describe("row overflow menu", () => {
  const actions = { patch: vi.fn(), transition: vi.fn(), isPending: false };

  function openRowMenu(status: IssueStatus, agentStatus?: "running" | "queued" | "failed" | null) {
    wrap(
      <IssueMobileCard
        row={row({ status, agentStatus })}
        slug="p1"
        actions={actions}
        now={Date.now()}
      />,
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

describe("StatusEdit, while an agent is working the issue", () => {
  it("offers no move, and says why rather than going quiet", () => {
    get.mockReturnValue(ANSWERED);
    openPicker("in_progress", "running");
    expect(labels()).toEqual([
      "An agent is working this — your move would be overwritten",
    ]);
    expect(screen.getByRole("menuitem")).toHaveAttribute("aria-disabled", "true");
  });

  it("leaves needs_info answerable however busy the issue is", () => {
    get.mockReturnValue(ANSWERED);
    openPicker("needs_info", "running");
    expect(labels()).not.toContain(
      "An agent is working this — your move would be overwritten",
    );
    expect(labels().length).toBeGreaterThan(0);
  });

  it("locks nothing when no agent holds the issue", () => {
    get.mockReturnValue(ANSWERED);
    openPicker("in_progress", null);
    expect(labels()).not.toContain(
      "An agent is working this — your move would be overwritten",
    );
  });
});

// ISS-1010 — the lock reaches every surface a live drive job writes over, not
// only the status picker. The row menu is the widest of them: it carries Status,
// Priority and Complexity on every row of every issues table.
describe("row overflow menu, while an agent is working the row", () => {
  const actions = { patch: vi.fn(), transition: vi.fn(), isPending: false };

  function openRowMenu(status: IssueStatus, agentStatus?: "running" | "queued" | "failed" | null) {
    wrap(
      <IssueMobileCard
        row={row({ status, agentStatus })}
        slug="p1"
        actions={actions}
        now={Date.now()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Row actions"));
  }

  const held = "An agent is working this — your edit would be overwritten";

  it("offers no status move", async () => {
    get.mockResolvedValue(ANSWERED);
    openRowMenu("in_progress", "running");
    await screen.findByText(held);
    expect(labels().filter((l) => l.startsWith("Status: "))).toEqual([]);
  });

  it("offers no priority change", async () => {
    get.mockResolvedValue(ANSWERED);
    openRowMenu("in_progress", "running");
    await screen.findByText(held);
    expect(labels().filter((l) => l.startsWith("Priority: "))).toEqual([]);
  });

  it("offers no complexity change", async () => {
    get.mockResolvedValue(ANSWERED);
    openRowMenu("in_progress", "running");
    await screen.findByText(held);
    expect(labels().filter((l) => l.startsWith("Complexity: "))).toEqual([]);
  });

  it("says why it offers nothing, rather than going quiet", async () => {
    get.mockResolvedValue(ANSWERED);
    openRowMenu("in_progress", "running");
    await screen.findByText(held);
    expect(labels()).toEqual(["Open issue", held]);
  });

  it("still offers Open issue, which nothing overwrites", async () => {
    get.mockResolvedValue(ANSWERED);
    openRowMenu("in_progress", "running");
    await screen.findByText(held);
    expect(labels()).toContain("Open issue");
  });

  it("leaves a needs_info row its moves however busy it is", async () => {
    get.mockResolvedValue(ANSWERED);
    openRowMenu("needs_info", "running");
    await vi.waitFor(() => expect(labels()).not.toContain(held));
    expect(labels().filter((l) => l.startsWith("Priority: ")).length).toBeGreaterThan(0);
  });

  it("locks nothing on a row no agent holds", async () => {
    get.mockResolvedValue(ANSWERED);
    openRowMenu("in_progress", null);
    await screen.findByText("Status: Developed");
    expect(labels()).not.toContain(held);
  });

  it("locks nothing on a row whose last session failed", async () => {
    get.mockResolvedValue(ANSWERED);
    openRowMenu("in_progress", "failed");
    await screen.findByText("Status: Developed");
    expect(labels()).not.toContain(held);
  });
});

describe("BulkActionBar, while an agent is working part of the selection", () => {
  function bulk(rows: IssueRow[]) {
    wrap(<BulkActionBar projectId="p1" selectedRows={rows} onCleared={vi.fn()} />);
    return (name: RegExp) => screen.getByRole("button", { name });
  }

  const describedBy = (el: HTMLElement) =>
    document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent;

  it("refuses Set status", async () => {
    get.mockResolvedValue(ANSWERED);
    const btn = bulk([row({ status: "open", agentStatus: "running" })]);
    await screen.findByText(/An agent is working this issue/);
    expect(btn(/Set status/)).toBeDisabled();
  });

  it("refuses Set priority, which has no state-machine constraint and was always offered", async () => {
    get.mockResolvedValue(ANSWERED);
    const btn = bulk([row({ status: "open", agentStatus: "running" })]);
    await screen.findByText(/An agent is working this issue/);
    expect(btn(/Set priority/)).toBeDisabled();
  });

  it("says how many of the selection an agent is holding", async () => {
    get.mockResolvedValue(ANSWERED);
    const btn = bulk([
      row({ status: "open", agentStatus: "running" }),
      row({ id: "i2", status: "open", agentStatus: null }),
    ]);
    await screen.findByText(/1 of the 2 selected issues/);
    expect(describedBy(btn(/Set status/))).toMatch(/1 of the 2 selected issues/);
  });

  it("names the live job rather than the unread registry", () => {
    get.mockReturnValue(new Promise(() => {}));
    bulk([row({ status: "open", agentStatus: "running" })]);
    expect(screen.queryByText("Loading the status moves…")).toBeNull();
    expect(screen.getByText(/An agent is working this issue/)).toBeInTheDocument();
  });

  // The shared fixture declares no exits out of `needs_info`, which would disable
  // Set status for a reason that is not the lock; this one declares them, so the
  // assertion is about the lock and nothing else.
  const ANSWERED_FROM_NEEDS_INFO = {
    ...ANSWERED,
    statusExits: { ...STATUS_EXITS, needs_info: ["in_progress", "on_hold"] },
  };

  it("offers Set status when every running issue in the selection is at needs_info", async () => {
    get.mockResolvedValue(ANSWERED_FROM_NEEDS_INFO);
    const btn = bulk([row({ status: "needs_info", agentStatus: "running" })]);
    await vi.waitFor(() => expect(btn(/Set status/)).not.toBeDisabled());
  });

  it("offers Set priority in that same selection", async () => {
    get.mockResolvedValue(ANSWERED_FROM_NEEDS_INFO);
    const btn = bulk([row({ status: "needs_info", agentStatus: "running" })]);
    await vi.waitFor(() => expect(btn(/Set priority/)).not.toBeDisabled());
  });
});
