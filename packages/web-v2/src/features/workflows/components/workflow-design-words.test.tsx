// The design page's rail speaks to a BA: plain sentences first, the kernel's terms (Unrooted, Not
// reconciled, Held, markers, permission strings) behind a collapsed Technical detail.

import type { WorkflowHealth } from "@forge/contracts/workflow-health";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import type { WorkflowDesign } from "../types";
import { buildGateSentence, healthSentences, reconciliationSentence, WorkflowDesignFacts } from "./workflow-design-facts";

const en = productCopy("en");

const KERNEL = /Unrooted|Not reconciled|Held|Markers|workflow-designs\.approve|rooted/;

const health = (over: Partial<WorkflowHealth> = {}): WorkflowHealth =>
  ({
    workflowId: "w1",
    flow: "order-flow",
    revision: 2,
    rooted: { rooted: false, approvedRevision: null, requirements: [], missing: ["approved_revision", "requirement"] },
    observation: null,
    markers: [],
    counts: { outdated: 0, needs_update: 0, has_problem: 0, remove_proposed: 0, upcoming: 0, not_in_design: 0, wrong: 0 },
    needsYou: 0,
    reconciliation: { state: "open", undecided: 0, cleaning: 0, issues: [], version: null, criteria: { total: 0, proven: 0 }, rule: "no observation" },
    ...over,
  }) as unknown as WorkflowHealth;

const design = { gate: { open: false, rule: "held until approved" }, builds: [], requirements: [], revisions: [], approver: "workflow-designs.approve", approvedRevision: null } as unknown as WorkflowDesign;

describe("the design rail's plain sentences", () => {
  it("say why the code is not compared, without the word Unrooted", () => {
    const [first] = healthSentences(health(), en);
    expect(first).toBe("The code is not being compared with this design: it has no approved revision yet and no requirement follows it.");
    expect(first).not.toMatch(KERNEL);
    expect(reconciliationSentence(health(), en)).not.toMatch(KERNEL);
    expect(buildGateSentence(design, en)).toBe("Work on this design is on hold until it is approved.");
  });

  it("count the differences and the ones that wait on a person", () => {
    const h = health({
      rooted: { rooted: true, approvedRevision: 2, requirements: ["REQ-1"], missing: [] },
      observation: { id: "o", atSha: "abc", revision: 2, createdAt: "2026-10-01T00:00:00Z", writtenBy: "u", writtenByAgency: "agent" },
      markers: [{}, {}] as never,
      needsYou: 1,
    });
    expect(healthSentences(h, en)).toEqual(["The code differs from this design in 2 places.", "1 difference needs a person to decide."]);
  });
});

describe("the rail keeps kernel terms behind Technical detail", () => {
  it("shows no kernel term until the detail is opened", async () => {
    const user = userEvent.setup();
    const shown = { steps: [], kind: "flow", summary: null } as never;
    render(
      <WorkflowDesignFacts
        d={design}
        record={{ writerName: "Ba", document: { updatedAt: "2026-10-01T00:00:00Z" } } as never}
        shown={shown}
        shownRevision={2}
        template={null}
        slug="epod"
        health={health()}
      />,
    );
    const rail = screen.getByTestId("design-facts");
    expect(screen.getByTestId("plain-status")).toBeInTheDocument();
    expect(rail.textContent).not.toMatch(KERNEL);
    expect(screen.queryByTestId("facts-health")).toBeNull();
    await user.click(screen.getByTestId("design-technical-toggle"));
    expect(screen.getByTestId("facts-health")).toBeInTheDocument();
    expect(screen.getByTestId("health-unrooted")).toHaveTextContent("Unrooted");
  });
});
