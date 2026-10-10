// The design page's rail speaks to a BA: plain sentences first, the kernel's terms (Unrooted, Not
// reconciled, Held, markers, permission strings) behind the Developer view (REQ-43 BC-7).

import { say, sentence } from "@/test/said";
import type { WorkflowHealth } from "@forge/contracts/workflow-health";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import type { WorkflowDesign } from "../types";
import { buildGateSentence, healthSentences, reconciliationSentence, WorkflowDesignProperties } from "./workflow-design-facts";

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
    reconciliation: { state: "open", undecided: 0, cleaning: 0, issues: [], version: null, criteria: { total: 0, proven: 0 }, rule: sentence(say("workflows.reconcile.unobserved")), says: { rule: say("workflows.reconcile.unobserved") } },
    ...over,
  }) as unknown as WorkflowHealth;

const HELD = say("designs.gate.held", { why: say("designs.gate.noApproval") });
const design = { gate: { open: false, rule: sentence(HELD), says: { rule: HELD } }, builds: [], requirements: [], revisions: [], approver: "workflow-designs.approve", approvedRevision: null } as unknown as WorkflowDesign;

describe("the design rail's plain sentences", () => {
  it("say why the code is not compared, without the word Unrooted", () => {
    const [first] = healthSentences(health(), en);
    expect(first).toBe("The code is not being compared with this design: not approved and no requirement.");
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

describe("the rail keeps kernel terms behind the Developer view", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));
  const shown = { steps: [], kind: "flow", summary: null } as never;
  const rail = () =>
    render(
      <WorkflowDesignProperties
        d={design}
        record={{ writerName: "Ba", document: { updatedAt: "2026-10-01T00:00:00Z" } } as never}
        shown={shown}
        shownRevision={2}
        template={null}
        slug="epod"
        health={health()}
      />,
    );

  it("shows no kernel term in the person view", () => {
    rail();
    expect(screen.getByTestId("plain-status")).toBeInTheDocument();
    expect(screen.getByTestId("design-facts").textContent).not.toMatch(KERNEL);
    expect(screen.queryByTestId("facts-health")).toBeNull();
  });

  it("draws the kernel's terms in the Developer view", () => {
    window.history.replaceState(null, "", "/?view=developer");
    rail();
    expect(screen.getByTestId("facts-health")).toBeInTheDocument();
    expect(screen.getByTestId("health-unrooted")).toHaveTextContent("Unrooted");
  });
});
