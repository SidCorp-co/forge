// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { IssueStanding, IssueStandingRow } from "@forge/contracts/issue-standing";
import { IssueBanner, issueRowView } from "./issue-standing-bits";

expect.extend(matchers);
afterEach(cleanup);

const JUDGE_RULE =
  "the change landed and no run holds it: it waits at step `test` for a judge, and moves to `awaiting_release` once every criterion passes";

const landedAtTest: IssueStanding = {
  state: "in_progress",
  step: "test",
  stepStartedAt: "2026-10-04T09:00:00Z",
  tone: "run",
  attentionGroup: "queued",
  waitingOn: { kind: "judge", who: "Judge", act: "landed · a verdict on each criterion", rule: JUDGE_RULE, ref: null },
  criteria: { total: 8, passing: 7, failing: 0, skipped: 0 },
  requirement: null,
  module: null,
  feedback: [],
  blockedBy: [],
  blocks: [],
  lease: { holder: "qa-80-holder-A", verdict: "expired", expiresAt: "2026-10-04T09:30:00Z" },
  inFlight: false,
  branch: null,
  headSha: null,
  owner: null,
  wave: 0,
  touchedAt: "2026-10-04T09:40:00Z",
};

const row: IssueStandingRow = {
  id: "i10",
  key: "ISS-10",
  title: "A landed issue",
  status: "in_progress",
  priority: "medium",
  category: null,
  complexity: null,
  assigneeId: null,
  createdById: null,
  createdAt: "2026-10-04T08:00:00Z",
  updatedAt: "2026-10-04T09:40:00Z",
  standing: landedAtTest,
};

describe("a landed issue at step test that nothing holds (ISS-80 criterion 8)", () => {
  it("the list row says it waits on a judge, from core's standing, never Stuck or No holder", () => {
    render(<div>{issueRowView("eco-a")(row).waitingOn}</div>);
    const w = screen.getByTestId("waiting-on");
    expect(w).toHaveAttribute("data-kind", "agent");
    expect(w).toHaveTextContent("Judge · landed · a verdict on each criterion");
    expect(w).toHaveAttribute("title", `Judge · landed · a verdict on each criterion — ${JUDGE_RULE}`);
    expect(w).not.toHaveTextContent("No holder");
  });

  it("the detail header's banner says whom it waits on and why, never Stuck", () => {
    render(<IssueBanner standing={landedAtTest} />);
    const b = screen.getByTestId("issue-banner");
    expect(b).toHaveTextContent("Waiting on Judge: landed · a verdict on each criterion");
    expect(b).not.toHaveTextContent("Stuck");
    expect(b).not.toHaveTextContent("in progress with no live run");
    expect(b).toHaveAttribute("title", JUDGE_RULE);
  });

  it("a landed open row reads as waiting on the run that claims it", () => {
    const open: IssueStanding = {
      ...landedAtTest,
      state: "open",
      step: null,
      waitingOn: { kind: "judge", who: "Next run", act: "landed · claim it and judge what landed", rule: "", ref: null },
    };
    render(<IssueBanner standing={open} />);
    expect(screen.getByTestId("issue-banner")).toHaveTextContent("Waiting on Next run: landed · claim it and judge what landed");
  });
});
