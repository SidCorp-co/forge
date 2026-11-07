// An issue's list row leads with names (ISS-1072): its facts name its module and its requirement by
// name, never a key, a criterion code, the feedback it came from or a met count, which the peek and
// the page show on demand; and a wait on its blocker reads "Blocker", the blocker's key in the tooltip.
// @direct-test-of packages/web-v2/src/features/issues/components/issue-standing-bits.tsx
// @direct-test-of packages/web-v2/src/features/forecast/components/eta-cell.tsx

import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { say, waitingOn } from "@/test/said";
import { issueRowView } from "./issue-standing-bits";

const AT = "2026-11-07T08:00:00.000Z";
const words = { t: productCopy(), time: { age: () => "1d", dateTime: () => "07/11/2026, 08:00" } } as never;

const row = {
  id: "i1",
  key: "ISS-1014",
  title: "An owner act a support room makes leaves no record",
  status: "open",
  priority: "high",
  standing: {
    state: "open",
    attentionGroup: "queued",
    waitingOn: waitingOn("issue", {
      who: say("standing.who.named", { name: "ISS-1013" }),
      act: say("issues.standing.act.designApproval"),
      rule: say("issues.rule.blockedDesign", { key: "ISS-1013", design: "Support room" }),
    }, { ref: "ISS-1013" }),
    criteria: { total: 3, met: 0, failing: 0, skipped: 0 },
    requirement: { key: "REQ-85", title: "Support rooms", criteria: ["BC-5", "BC-6", "BC-7"], staleCriteria: ["BC-2"], plannedRevision: 1, currentRevision: 1, changedSincePlan: false },
    module: { id: "m1", path: "support/rooms", name: "Support rooms" },
    feedback: ["FB-511"],
    feedbackDropped: [],
    blockedBy: [{ key: "ISS-1013", title: "Support room design", status: "open", group: "queued", landed: false, designHold: "Support room" }],
    blocks: [],
    owner: null,
    touchedAt: AT,
  },
} as unknown as IssueStandingRow;

describe("an issue's list row", () => {
  const v = issueRowView("forge", words)(row);

  it("names its module and requirement, the keys, codes, source and met count left to the peek", () => {
    render(<>{v.facts}</>);
    const facts = document.body.textContent ?? "";
    expect(facts).toContain("Support rooms");
    expect(facts).toContain("High priority");
    expect(facts).not.toMatch(/REQ-85|BC-\d|FB-511|Met \d|support\/rooms/);
  });

  it("reads a wait on its blocker as Blocker, the blocker's key in the tooltip", () => {
    render(<>{v.waitingOn}</>);
    const cell = screen.getByTestId("waiting-on");
    expect(cell.textContent).toBe("Blocker · design approval");
    expect(cell.getAttribute("title")).toContain("ISS-1013");
  });
});
