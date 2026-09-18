// @vitest-environment jsdom
//
// ISS-1097 — the column headed STATUS prints the status.
//
// The oracle below is spelled out HERE and never imported from `STATUS_LABELS`.
// A test that read its expected words out of the production map would follow
// that map wherever it went: swap "Testing" and "Tested" in `derive.ts` and an
// importing test stays green while two rows report the wrong status. The
// fixture is the second opinion, so a wrong word in the map fails here.
//
// The lane vocabulary folds seven kernel statuses onto "Running" and two onto
// "Needs a human", so a case naming one status and one word can also pass
// against a map that hardcodes it. The two collapse cases below therefore
// assert the SHAPE of the fix — n statuses, n distinct words, and the lane
// word absent — which no hardcoded entry satisfies by accident.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { laneLabel, statusLabel } from "../derive";
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
  confirmed: "Confirmed",
  clarified: "Clarified",
  approved: "Approved",
  in_progress: "In progress",
  developed: "Developed",
  testing: "Testing",
  tested: "Tested",
  awaiting_release: "Awaiting release",
  releasing: "Releasing",
  reopen: "Reopened",
  waiting: "Waiting",
  on_hold: "On hold",
  needs_info: "Needs info",
  closed: "Closed",
  dropped: "Dropped",
};

const row = (status: IssueStatus): IssueRow =>
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
  }) as IssueRow;

/** The word the STATUS column prints for a row at this status. */
function printed(status: IssueStatus): string {
  const { container, unmount } = render(<StatusCell row={row(status)} />);
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

  // cm:guard the whole reported defect, in the shape it was reported in: seven rows, one word.
  it("tells apart every status the lane folds onto Running", () => {
    const folded = ISSUE_STATUSES.filter((s) => laneLabel(s) === "Running");
    expect(folded.length).toBeGreaterThan(1);
    const words = folded.map(printed);
    expect(new Set(words).size).toBe(folded.length);
    expect(words).not.toContain("Running");
  });

  it("tells apart every status the lane folds onto Needs a human", () => {
    const folded = ISSUE_STATUSES.filter((s) => laneLabel(s) === "Needs a human");
    expect(folded.length).toBeGreaterThan(1);
    const words = folded.map(printed);
    expect(new Set(words).size).toBe(folded.length);
    expect(words).not.toContain("Needs a human");
  });

  // cm:guard the issue's own Outcome sentence, verbatim: "a reader can tell `releasing` from
  // `approved`, and `needs_info` from `waiting`, without opening the row".
  it("tells releasing from approved", () => {
    expect(printed("releasing")).not.toBe(printed("approved"));
  });

  it("tells needs_info from waiting", () => {
    expect(printed("needs_info")).not.toBe(printed("waiting"));
  });

  it("prints the row's OWN status and not a fixed word", () => {
    expect(printed("releasing")).toBe("Releasing");
    expect(printed("approved")).toBe("Approved");
  });
});

describe("the word the detail header prints", () => {
  // cm:guard the header calls `statusLabel`, the same export this column does, so the two cannot
  // drift. Asserting the header's own render would need the whole detail screen and its queries;
  // what makes the two agree is that one function answers for both, and that is what this asserts.
  it("is the same function's answer as the column's, for every status", () => {
    for (const s of ISSUE_STATUSES) {
      expect(statusLabel(s), s).toBe(EXPECTED[s]);
      expect(printed(s), s).toBe(statusLabel(s));
    }
  });
});
