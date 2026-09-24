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
// The lane vocabulary folds seven statuses onto "Running" and two onto "Needs a
// human", so the two collapse cases assert the SHAPE — n statuses, n distinct
// words, the lane word absent — which no hardcoded entry satisfies by accident.

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("tells apart every status the lane folds onto Running", () => {
    const folded = ISSUE_STATUSES.filter((s) => laneLabel(s, true) === "Running");
    expect(folded.length).toBeGreaterThan(1);
    const words = folded.map(printed);
    expect(new Set(words).size).toBe(folded.length);
    expect(words).not.toContain("Running");
  });

  it("tells apart every status the lane folds onto Needs a human", () => {
    const folded = ISSUE_STATUSES.filter((s) => laneLabel(s, true) === "Needs a human");
    expect(folded.length).toBeGreaterThan(1);
    const words = folded.map(printed);
    expect(new Set(words).size).toBe(folded.length);
    expect(words).not.toContain("Needs a human");
  });

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
  // The header is one line inside a screen needing a router, a query client and a dozen hooks, and
  // mocking all of that would put the assertion further from the call site. So this reads the
  // SHIPPED call site out of the source, which is exactly the one-expression edit it has to catch.
  const header = readFileSync(
    join(import.meta.dirname, "issue-detail-screen.tsx"),
    "utf8",
  );
  const chip = header
    .split("\n")
    .find((l) => l.includes("<StatusChip") && l.includes("statusToChip(issue.status)"));

  it("reads a call site that is actually there", () => {
    expect(chip, "the detail header's StatusChip line was not found").toBeDefined();
  });

  it("labels the header chip with the kernel status and not the lane word", () => {
    expect(chip).toMatch(/label=\{statusLabel\(issue\.status\)\}/u);
    expect(chip).not.toMatch(/laneLabel/u);
  });

  // And the two surfaces then agree because one function answers for both.
  it("is the same function's answer as the column's, for every status", () => {
    for (const s of ISSUE_STATUSES) {
      expect(statusLabel(s), s).toBe(EXPECTED[s]);
      expect(printed(s), s).toBe(statusLabel(s));
    }
  });
});
