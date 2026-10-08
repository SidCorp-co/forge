// @vitest-environment jsdom
//
// ISS-1156, criterion 17 — a project holding more open-work issues than one board page. The judge
// walked 230: the search returns a page of 200 and the board drew 40 / 80 / 40 / 40 against the
// strip's 46 / 92 / 46 / 46, naming none of the 30 it left off. The board asks the search for the
// count of each state with the page and names what each state's columns do not hold.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineIssueRow } from "../types";

expect.extend(matchers);
afterEach(cleanup);

const { state } = vi.hoisted(() => ({
  state: { items: [] as unknown[], byWorkState: {} as Record<string, number> },
}));

vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("../hooks", () => ({
  useProjectIssues: () => ({
    isLoading: false,
    isError: false,
    data: { items: state.items, totalCount: 230, extra: { buckets: { byWorkState: state.byWorkState } } },
  }),
  useProjectRuns: () => ({ isLoading: false, isError: false, data: { items: [], totalCount: 0 } }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjectHealth: () => ({
    // Open-state totals unlike the search's, so a board reading them from here instead of from the
    // search response fails the figures asserted below.
    data: [{ id: "p1", work: { open: 7, in_flight: 7, awaiting_release: 7, blocked_on_person: 7, draft: 0, finished: 0 } }],
  }),
}));
vi.mock("./run-detail", () => ({ RunDetail: () => null }));

import { PipelineBoard } from "./pipeline-board";

const row = (status: string, i: number): PipelineIssueRow =>
  ({
    id: `${status}-${i}`,
    projectId: "p1",
    displayId: `ISS-${status}-${i}`,
    title: `issue ${status} ${i}`,
    status,
    priority: "medium",
    assigneeId: null,
    held: true,
    lastCheckInAt: null,
  }) as unknown as PipelineIssueRow;

/** 230 open-work issues, the first 200 of them on the page. */
function mountOverOnePage() {
  const per: Array<[string, number]> = [
    ["open", 46],
    ["in_progress", 92],
    ["awaiting_release", 46],
    ["needs_info", 46],
  ];
  state.items = per.flatMap(([status, n]) => Array.from({ length: n }, (_, i) => row(status, i))).slice(0, 200);
  state.byWorkState = { open: 46, in_flight: 92, awaiting_release: 46, blocked_on_person: 46, draft: 0, finished: 0 };
  return render(<PipelineBoard scope={{ projectId: "p1", slug: "wren" }} />);
}

describe("the board over one page of issues", () => {
  it("names the issues its page left undrawn, state by state, from the search's own counts", () => {
    mountOverOnePage();
    const cut = screen.getByTestId("board-page-cut");
    expect(cut).toHaveTextContent("The columns hold 200 of the 230 open issues");
    expect(screen.getByRole("link", { name: "Blocked on a person: 16 of 46 drawn" })).toHaveAttribute(
      "href",
      "/projects/wren/issues?filter=blocked_on_person",
    );
  });

  it("leaves what it drew in full unnamed", () => {
    mountOverOnePage();
    expect(screen.queryByRole("link", { name: /^Open, not picked up:/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^In flight:/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Awaiting release:/ })).toBeNull();
  });
});
