// @vitest-environment jsdom
//
// ISS-1156 — the project dashboard's Needs you tile and list. A response that cannot say how much
// the list leaves out is refused where the tile is, naming what is missing, and the rest of the
// dashboard stands; it does not fail the page.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

const noQuery = { data: undefined, isLoading: false, isError: false };
let attentionView: unknown;

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "pair" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => {} }));
vi.mock("@/features/attention/hooks", () => ({ useAttention: () => ({ view: attentionView }) }));
vi.mock("@/features/pipeline/hooks", () => ({
  useProjectRuns: () => noQuery,
  useStepDurations: () => noQuery,
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ ...noQuery, data: [{ id: "p1", slug: "pair", name: "Pair" }] }),
  useProjectHealth: () => ({
    ...noQuery,
    data: [
      {
        projectSlug: "pair",
        blockers: [
          { issueId: "ISS-5", documentId: "d5", status: "on_hold" },
          { issueId: "ISS-2", documentId: "d2", status: "on_hold" },
          { issueId: "ISS-3", documentId: "d3", status: "needs_info" },
        ],
        blockersTotal: 3,
        work: { open: 1, in_flight: 1, awaiting_release: 0, blocked_on_person: 5, draft: 0, finished: 0 },
        spend24hUsd: 0,
      },
    ],
  }),
}));
vi.mock("@/features/runners/hooks", () => ({ useActiveRunners: () => noQuery, useProjectRunners: () => noQuery }));
vi.mock("@/features/schedules/hooks", () => ({ useSchedules: () => noQuery }));
vi.mock("@/features/sessions/hooks", () => ({ useQueueStats: () => noQuery }));
vi.mock("@/features/project-dashboard/components/live-runs-card", () => ({ LiveRunsCard: () => null }));
vi.mock("@/features/project-dashboard/components/awaiting-release-card", () => ({ AwaitingReleaseCard: () => null }));
vi.mock("@/features/project-dashboard/components/runners-card", () => ({ RunnersCard: () => null }));
vi.mock("@/features/project-dashboard/components/schedules-card", () => ({ SchedulesCard: () => null }));
vi.mock("@/features/project-dashboard/components/spend-card", () => ({ SpendCard: () => null }));

const { default: ProjectOverviewPage } = await import("./page");

const view = (projectTotals: unknown) => ({
  needsReview: [],
  awaitingInput: [],
  mentions: [],
  failedJobs: [],
  pendingSkillUpdates: [],
  unseenDrafts: [],
  unseenDraftsTotal: 0,
  projectTotals,
  total: 0,
  offlineRunners: [],
});

function needsYouTile(): HTMLElement {
  const tile = screen.getByText("Needs you").closest("div.rounded-lg");
  if (!(tile instanceof HTMLElement)) throw new Error("the Needs you tile is not on the page");
  return tile;
}

describe("the project dashboard's Needs you", () => {
  it("says 3 of at least 4 where the viewer's own waiting issue is owed and none of it is listed (j4's F1)", () => {
    attentionView = view({
      pair: { needsReview: 0, awaitingInput: 1, awaitingOutsideBlockers: 1, failedJobs: 0 },
    });
    render(<ProjectOverviewPage />);
    const tile = needsYouTile();
    expect(within(tile).getByText("3")).toBeInTheDocument();
    expect(within(tile).getByText(/3 of at least 4$/u)).toBeInTheDocument();
    expect(screen.getByText("Showing 3 of at least 4.", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/needs attention 3 of at least 4/u)).toBeInTheDocument();
  });

  it("refuses a response with no projectTotals where the tile is, and keeps the rest of the dashboard standing", () => {
    attentionView = view(undefined);
    render(<ProjectOverviewPage />);
    const tile = needsYouTile();
    expect(within(tile).getByText(/no `projectTotals`.*not the release/u)).toBeInTheDocument();
    expect(within(tile).getByText("—")).toBeInTheDocument();
    expect(screen.getByTestId("attention-refusal")).toHaveTextContent("no `projectTotals`");
    expect(screen.queryByText(/needs attention/u)).toBeNull();
    // the rest of the page is still drawn
    expect(screen.getByText("Open work by state")).toBeInTheDocument();
    expect(screen.getByText("Open work")).toBeInTheDocument();
  });
});
