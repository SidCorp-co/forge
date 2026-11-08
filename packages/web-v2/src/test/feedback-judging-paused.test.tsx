// ISS-1148 (ISS-1137 outcome 6a): with the steward's runner jobs spent for the UTC day, six of
// thirteen Feedback rows each said "The steward's daily budget for this project is spent", one
// project-wide fact repeated per row. The list now says it once, above its rows, as core's budget
// read gives it: judging resumes at the next 00:00Z. A day with jobs left says nothing.
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-screen.tsx
// @direct-test-of packages/web-v2/src/features/feedback/hooks.ts

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { FEEDBACK_SEED, P } from "@/test/vi-chrome-feedback";
import { Seeded } from "@/test/vi-chrome-requirements";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(cleanup);

const day = (judgingPaused: boolean) => ({
  day: "2026-11-08T00:00:00.000Z",
  resumesAt: "2026-11-09T00:00:00.000Z",
  judgingPaused,
  handoff: { gatewayTurns: { spent: 0, of: 40 }, runnerJobs: { spent: 10, of: 10 }, kept: { gatewayTurns: 20, runnerJobs: 5 } },
  sweep: { gatewayTurns: { spent: 0, of: 20 }, runnerJobs: { spent: 0, of: 5 } },
  paced: 0,
  quiet: null,
});

function list(judgingPaused: boolean) {
  return render(
    <Seeded data={[...FEEDBACK_SEED, [["steward-budget", P], day(judgingPaused)]]}>
      <FeedbackScreen projectId={P} slug="hop" />
    </Seeded>,
  );
}

describe("the Feedback list while the steward's day is spent", () => {
  it("says once, above the rows, when judging resumes", async () => {
    list(true);
    const line = await screen.findByTestId("feedback-judging-paused");
    expect(line.textContent).toBe("Judging resumes at 00:00 UTC.");
    expect(screen.getAllByText(/Judging resumes/)).toHaveLength(1);
  });

  it("says nothing while jobs are left", async () => {
    list(false);
    await screen.findByRole("button", { name: /new feedback/i });
    expect(screen.queryByTestId("feedback-judging-paused")).toBeNull();
  });
});
