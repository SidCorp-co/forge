// coverage-truth r2. The issue rail said "Traces to BC-1 … BC-10" on ISS-479 although its BC-4 and
// BC-8 rows traced wording REQ-37 had retired, which the requirement counts as stale; and the
// Criteria tab drew a Short verdict as "✓ Pass". A trace on an earlier wording reads stale and names
// the re-tie act, and a Short reads Short (it still counts as a pass in coverage).

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import type { IssueDetail } from "../types";
import { CriteriaTab } from "./detail/issue-tabs";
import { IssueStandingFacts } from "./issue-standing-bits";

const AT = "2026-10-08T21:49:14.000Z";

const row = {
  id: "i479",
  key: "ISS-479",
  title: "Scripts",
  status: "closed",
  priority: "medium",
  standing: {
    attentionGroup: "done",
    criteria: { total: 10, passing: 8, failing: 0, skipped: 0 },
    requirement: {
      key: "REQ-37",
      title: "Scripts",
      criteria: ["BC-1", "BC-2"],
      staleCriteria: ["BC-4", "BC-8"],
      plannedRevision: null,
      currentRevision: 2,
      changedSincePlan: false,
    },
    module: null,
    feedback: [],
    blockedBy: [],
    blocks: [],
    owner: null,
    touchedAt: AT,
  },
} as unknown as IssueStandingRow;

describe("the issue rail's requirement traces", () => {
  it("lists only current traces as traced, and names the earlier-wording ones stale with the re-tie act", () => {
    renderWithQuery(<IssueStandingFacts row={row} slug="forge" />);
    const req = screen.getByTestId("facts-requirement");
    expect(req).toHaveTextContent("Traces to BC-1, BC-2");
    expect(req).not.toHaveTextContent("BC-1, BC-2, BC-4");
    expect(within(req).getByTestId("stale-traces")).toHaveTextContent(
      "BC-4, BC-8 trace an earlier wording, which counts as stale: tie them again from the Criteria tab, then judge them",
    );
  });
});

describe("a Short verdict on the Criteria tab", () => {
  it("reads Short, met short of its wording, not Pass", async () => {
    fakeCore((c) =>
      c.path === "/issues/i1/criteria"
        ? {
            body: {
              criteria: [
                { id: "k1", n: 1, statement: "(REQ-37 BC-5) Scripts run", position: 0, requirementCriterionId: "w5", latest: { verdict: "short", reason: "met", identityKind: "commit", commitSha: "9739dd37b".padEnd(40, "0"), authorAgency: "agent", createdAt: AT } },
                { id: "k2", n: 2, statement: "(REQ-37 BC-7) Scripts stop", position: 1, requirementCriterionId: "w7", latest: { verdict: "pass", reason: "ok", identityKind: "commit", commitSha: "0fecd0850".padEnd(40, "0"), authorAgency: "agent", createdAt: AT } },
              ],
            },
          }
        : undefined,
    );
    renderWithQuery(<CriteriaTab issue={{ id: "i1", projectId: "p1", status: "closed" } as IssueDetail} projectId="p1" hasCriteriaRows checklist={[]} canWrite={false} requirementKey="REQ-37" />);
    const short = await screen.findByTestId("criterion-1-verdict");
    expect(short).toHaveTextContent("Short");
    expect(short).not.toHaveTextContent("Pass");
    expect(screen.getByTestId("criterion-2-verdict")).toHaveTextContent("Pass");
  });
});
