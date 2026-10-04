// @vitest-environment jsdom
//
// The grouped Issues views read core's standing and only arrange it: Attention by its group, Module
// by its primary module, Waves by its wave. The quick filters and the assistant's params narrow
// what is shown, and a narrowed view says so.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueStandingList, IssueStandingRow } from "@forge/contracts/issue-standing";
import { IssuesBoard, waveEdges } from "./issues-board";

expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => {
  window.history.replaceState(null, "", "/projects/hop/issues");
  sessionStorage.clear();
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const row = (key: string, over: Partial<IssueStandingRow["standing"]> & { status?: IssueStandingRow["status"]; priority?: string } = {}): IssueStandingRow => {
  const { status = "open", priority = "medium", ...standing } = over;
  return {
    id: key,
    key,
    title: `Title of ${key}`,
    status,
    priority,
    category: null,
    complexity: null,
    assigneeId: null,
    createdById: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    standing: {
      state: status,
      step: null,
      stepStartedAt: null,
      tone: "ready",
      attentionGroup: "queued",
      waitingOn: { kind: "master", who: "Master", act: "free slot", rule: "", ref: null },
      criteria: { total: 0, passing: 0, failing: 0, skipped: 0 },
      requirement: null,
      module: null,
      feedback: [],
      blockedBy: [],
      blocks: [],
      lease: null,
      inFlight: false,
      branch: null,
      headSha: null,
      owner: null,
      wave: 0,
      touchedAt: "2026-10-01T00:00:00Z",
      ...standing,
    },
  };
};

const ROWS = [
  row("ISS-1", { attentionGroup: "needs_you", tone: "you", status: "needs_info", module: { id: "m1", path: "storefront/publish", name: "publish" } }),
  row("ISS-2", { attentionGroup: "stuck", tone: "blocked", wave: 1, blockedBy: [{ key: "ISS-3", title: "t", status: "in_progress", group: "moving", landed: false }] }),
  row("ISS-3", { attentionGroup: "moving", tone: "run", status: "in_progress", blocks: [{ key: "ISS-2", title: "t", status: "open", group: "stuck", landed: false }], module: { id: "m1", path: "storefront/publish", name: "publish" } }),
];
const DATA: IssueStandingList = { issues: ROWS, counts: { open: 3, closed: 0, all: 3, needsYou: 1, blocked: 1, blocking: 1 }, returned: 3, limit: 500, releaseApproval: true };

vi.mock("../hooks", () => ({ useIssueStanding: () => ({ data: DATA, isLoading: false, isError: false, error: null, refetch: vi.fn() }) }));

const keys = () => screen.queryAllByTestId("list-row").map((r) => r.dataset.key);

describe("IssuesBoard", () => {
  it("groups by whose turn it is, label first, in the read model's order", () => {
    render(<IssuesBoard scope={{ projectId: "p", slug: "hop" }} mode="attention" />);
    expect(screen.getAllByTestId("list-group").map((g) => g.dataset.group)).toEqual(["needs_you", "moving", "stuck"]);
    expect(keys()).toEqual(["ISS-1", "ISS-3", "ISS-2"]);
  });

  it("narrows to Waiting on you and writes the filter to the URL", () => {
    render(<IssuesBoard scope={{ projectId: "p", slug: "hop" }} mode="attention" />);
    fireEvent.click(screen.getByTestId("quick-you"));
    expect(window.location.search).toBe("?f=you");
    expect(keys()).toEqual(["ISS-1"]);
  });

  it("says when the assistant narrowed the view, and clears it", () => {
    window.history.replaceState(null, "", "/projects/hop/issues?status=in_progress");
    render(<IssuesBoard scope={{ projectId: "p", slug: "hop" }} mode="attention" />);
    expect(keys()).toEqual(["ISS-3"]);
    const line = screen.getByTestId("issues-narrowed");
    expect(line).toHaveTextContent("Status In progress");
    fireEvent.click(within(line).getByRole("button", { name: "Clear" }));
    expect(keys()).toHaveLength(3);
  });

  it("groups by primary module, an issue without one last", () => {
    render(<IssuesBoard scope={{ projectId: "p", slug: "hop" }} mode="module" />);
    const groups = screen.getAllByTestId("list-group");
    expect(groups.map((g) => g.textContent?.split(/\d/)[0])).toEqual(["storefront/publish", "No module"]);
    expect(groups[0]).toHaveTextContent("Needs you 1");
  });

  it("lays out waves, wave 0 splitting chain roots from issues that block nothing", () => {
    render(<IssuesBoard scope={{ projectId: "p", slug: "hop" }} mode="waves" />);
    const waves = screen.getAllByTestId("wave");
    expect(waves.map((w) => w.dataset.wave)).toEqual(["0", "1"]);
    expect(within(waves[0] as HTMLElement).getByText("Chain roots 1")).toBeInTheDocument();
    expect(within(waves[1] as HTMLElement).getByText("Waits on ISS-3")).toBeInTheDocument();
    expect(screen.getByTestId("wave-edges")).toBeInTheDocument();
  });

  it("draws an edge from each blocker to what it holds back, and none to a card not shown", () => {
    const hidden = row("ISS-9", { wave: null, blocks: [{ key: "ISS-1", title: "t", status: "open", group: "queued", landed: false }] });
    const held = row("ISS-1", { wave: 1, blockedBy: [{ key: "ISS-9", title: "t", status: "closed", group: "done", landed: false }] });
    expect(waveEdges(ROWS)).toEqual([{ from: "ISS-3", to: "ISS-2" }]);
    expect(waveEdges([hidden, held])).toEqual([]);
  });

  it("opens a peek from a row and names its place among the visible rows", () => {
    render(<IssuesBoard scope={{ projectId: "p", slug: "hop" }} mode="attention" />);
    fireEvent.click(screen.getByText("Title of ISS-3"));
    expect(window.location.search).toBe("?peek=ISS-3");
    const peek = screen.getByTestId("issue-peek");
    expect(within(peek).getByTestId("peek-position")).toHaveTextContent("2 of 3");
    expect(within(peek).getByTestId("issue-banner")).toHaveTextContent("Waiting on Master");
  });
});
