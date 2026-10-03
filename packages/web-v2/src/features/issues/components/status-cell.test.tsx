// @vitest-environment jsdom
//
// ISS-1097 — the column headed STATUS prints the status.
//
// The oracle below is spelled out HERE and never imported from `STATUS_LABELS`.
// A test that read its expected words out of the production map would follow
// that map wherever it went: swap "Approved" and "Awaiting release" in the map
// and an importing test stays green while two rows report the wrong status. The
// fixture is the second opinion, so a wrong word in the map fails here.
//
// ISS-54: the ten statuses are what the lane's labels were, so there is no second
// vocabulary to fold onto. The run's step is the one addition — "In progress ·
// Test" — and only on in_progress, only where the work state names one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORK_STEPS, type WorkStep } from "@forge/contracts/issue-vocabulary";
import { statusLabel } from "../derive";
import { ISSUE_STATUSES } from "../types";
import type { IssueRow, IssueStatus } from "../types";
import { StatusCell } from "./issue-row-actions";

expect.extend(matchers);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

/** Written here, on purpose, rather than imported. See the header. */
const EXPECTED: Record<IssueStatus, string> = {
  draft: "Draft",
  open: "Open",
  reopen: "Reopened",
  in_progress: "In progress",
  approved: "Approved",
  needs_info: "Needs info",
  on_hold: "On hold",
  awaiting_release: "Awaiting release",
  closed: "Closed",
  dropped: "Dropped",
};

/** The step words, written here for the same reason. */
const STEP_WORD: Record<WorkStep, string> = {
  triage: "Triage",
  clarify: "Clarify",
  plan: "Plan",
  build: "Build",
  test: "Test",
  release: "Release",
};

const row = (status: IssueStatus, step: WorkStep | null = null): IssueRow =>
  ({
    id: "i",
    projectId: "p",
    issSeq: 1097,
    displayId: "ISS-1097",
    title: "A row",
    status,
    priority: "medium",
    category: null,
    complexity: null,
    assigneeId: null,
    createdById: "u",
    creatorEmail: null,
    creatorIsAgent: false,
    creatorLabel: "A person",
    reopenCount: 0,
    mergedAt: null,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    agentStatus: null,
    workState: step
      ? { step, stepStartedAt: null, leaseHolder: null, branch: null, headSha: null, leftStatus: null, legacyStatus: null }
      : null,
  }) as IssueRow;

/** The word the STATUS column prints for a row at this status (and step). */
function printed(status: IssueStatus, step: WorkStep | null = null): string {
  const { container, unmount } = render(<StatusCell row={row(status, step)} />);
  const text = container.textContent ?? "";
  unmount();
  return text.trim();
}

describe("the column headed STATUS prints the kernel status", () => {
  it("prints the fixture's word for every kernel status", () => {
    for (const s of ISSUE_STATUSES) {
      expect(EXPECTED[s], `no expected word written for ${s}`).toBeTruthy();
      expect(printed(s), s).toBe(EXPECTED[s]);
    }
  });

  it("covers every kernel status the union has, so a new one cannot slip past", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ISSUE_STATUSES].sort());
  });

  it("tells every status apart, so no two print the same word", () => {
    const words = ISSUE_STATUSES.map((s) => printed(s));
    expect(new Set(words).size).toBe(ISSUE_STATUSES.length);
    expect(words).not.toContain("Running");
    expect(words).not.toContain("Needs a human");
  });

  it("tells needs_info from on_hold", () => {
    expect(printed("needs_info")).not.toBe(printed("on_hold"));
  });

  it("prints the row's OWN status and not a fixed word", () => {
    expect(printed("awaiting_release")).toBe("Awaiting release");
    expect(printed("approved")).toBe("Approved");
  });

  it("prints the run's step after In progress where the work state names one", () => {
    for (const step of WORK_STEPS) {
      expect(printed("in_progress", step), step).toBe(`In progress · ${STEP_WORD[step]}`);
    }
  });

  it("prints no step beside any other status, whatever the work state says", () => {
    for (const s of ISSUE_STATUSES.filter((x) => x !== "in_progress")) {
      expect(printed(s, "test"), s).toBe(EXPECTED[s]);
    }
  });
});

describe("the word the detail header prints", () => {
  // The header is one line inside a screen needing a router, a query client and a dozen hooks, and
  // mocking all of that would put the assertion further from the call site. So this reads the
  // SHIPPED call site out of the source, which is exactly the one-expression edit it has to catch.
  const header = readFileSync(
    join(import.meta.dirname, "issue-detail-screen.tsx"),
    "utf8",
  );
  const chip = header
    .split("\n")
    .find((l) => l.includes("<StatusBadge") && l.includes("value={issue.status}"));

  it("reads a call site that is actually there", () => {
    expect(chip, "the detail header's StatusBadge line was not found").toBeDefined();
  });

  it("labels the header badge through the one status reading, with the issue's own step", () => {
    expect(chip).toMatch(/family="issue" value=\{issue\.status\} step=\{workStepOf\(issue\)\}/u);
    expect(chip).not.toMatch(/label=/u);
  });

  // And the two surfaces then agree because one function answers for both.
  it("is the same function's answer as the column's, for every status", () => {
    for (const s of ISSUE_STATUSES) {
      expect(statusLabel(s), s).toBe(EXPECTED[s]);
      expect(printed(s), s).toBe(statusLabel(s));
    }
  });
});
