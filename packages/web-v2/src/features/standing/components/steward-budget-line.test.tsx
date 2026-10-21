// The Dashboard's line for a quiet steward (REQ-48 BC-1): the whole day spent says when it acts
// again; only the sweep's share spent says how many stuck items wait and that handoffs still run;
// a steward with budget draws nothing.

import type { StewardBudgetView } from "@forge/contracts/steward-runtime";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { StewardBudgetSentence } from "./steward-budget-line";

const share = (spent: number, of: number) => ({ gatewayTurns: { spent, of }, runnerJobs: { spent: 0, of: 4 } });
const day = (over: Partial<StewardBudgetView>): StewardBudgetView => ({
  day: "2026-10-22T00:00:00.000Z",
  resumesAt: "2026-10-23T00:00:00.000Z",
  handoff: share(3, 80),
  sweep: share(40, 120),
  paced: 0,
  quiet: null,
  ...over,
});

describe("the steward's budget line", () => {
  it("says the whole day is spent, and when the steward acts again", () => {
    renderWithQuery(<StewardBudgetSentence budget={day({ quiet: "handoffs", handoff: share(80, 80), sweep: share(120, 120) })} />);
    expect(screen.getByTestId("steward-budget-line")).toHaveTextContent(/^The steward's budget for today is spent until 23\/10\/2026, .+\.$/);
  });

  it("says how many stuck items wait for tomorrow while handoffs still get the steward", () => {
    renderWithQuery(<StewardBudgetSentence budget={day({ quiet: "sweep", sweep: share(120, 120), paced: 27 })} />);
    expect(screen.getByTestId("steward-budget-line")).toHaveTextContent(
      "27 stuck items wait for tomorrow; new feedback and requirements still run.",
    );
  });

  it("draws nothing while the steward has budget", () => {
    renderWithQuery(<StewardBudgetSentence budget={day({})} />);
    expect(screen.queryByTestId("steward-budget-line")).toBeNull();
  });
});
