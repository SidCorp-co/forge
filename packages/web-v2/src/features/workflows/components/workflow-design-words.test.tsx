// The design page's rail speaks to a BA: plain sentences first, the kernel's terms (Unrooted, Not
// reconciled, Held, markers, permission strings) behind the Developer view (REQ-43 BC-7).

import { say, sentence } from "@/test/said";
import type { WorkflowHealth } from "@forge/contracts/workflow-health";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowDesign } from "../types";
import { codeMatchOf, WorkflowDesignProperties } from "./workflow-design-facts";

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

const OBSERVED = { id: "o", atSha: "abc", revision: 2, createdAt: "2026-10-01T00:00:00Z", writtenBy: "u", writtenByAgency: "agent" };
const ROOTED = { rooted: true, approvedRevision: 2, requirements: ["REQ-1"], missing: [] };

describe("whether the code matches the design, as a mark and a word or two", () => {
  it("reads Not compared while the design is unrooted or unobserved", () => {
    expect(codeMatchOf(health())).toEqual({ stand: "no", key: "workflows.stands.notCompared" });
    expect(codeMatchOf(health({ rooted: ROOTED }))).toEqual({ stand: "no", key: "workflows.stands.notCompared" });
    expect(codeMatchOf(undefined).key).toBe("workflows.stands.notCompared");
  });

  it("reads Differs while a marker stands, Matches once reconciled, else Not confirmed", () => {
    expect(codeMatchOf(health({ rooted: ROOTED, observation: OBSERVED, markers: [{}] as never })).stand).toBe("differs");
    const reconciled = health({ rooted: ROOTED, observation: OBSERVED });
    expect(codeMatchOf({ ...reconciled, reconciliation: { ...reconciled.reconciliation, state: "reconciled" } })).toEqual({ stand: "yes", key: "workflows.stands.matches" });
    expect(codeMatchOf(reconciled)).toEqual({ stand: "no", key: "workflows.stands.notConfirmed" });
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

  // ISS-781 C7: Where it stands is three marked rows, each at most three words, and no sentence
  it("says where the design stands as three marks of at most three words, no sentence", () => {
    rail();
    const rows = ["stands-approved", "stands-requirement", "stands-code"].map((id) => screen.getByTestId(id));
    expect(rows.map((r) => r.querySelector("[data-stand]")?.getAttribute("data-stand"))).toEqual(["no", "no", "no"]);
    expect(rows.map((r) => r.textContent)).toEqual(["ApprovedNo", "RequirementNone", "Code matchNot compared"]);
    for (const r of rows) {
      const value = r.querySelector("[data-stand]")?.textContent ?? "";
      expect(value.trim().split(/\s+/).length, `"${value}" is more than three words`).toBeLessThanOrEqual(3);
    }
    expect(screen.getByTestId("plain-status").textContent).not.toMatch(/[.:]/);
    expect(screen.getByTestId("design-facts").textContent).not.toMatch(/on hold|not approved yet/i);
  });

  it("draws the kernel's terms in the Developer view", () => {
    window.history.replaceState(null, "", "/?view=developer");
    rail();
    expect(screen.getByTestId("facts-health")).toBeInTheDocument();
    expect(screen.getByTestId("health-unrooted")).toHaveTextContent("Unrooted");
  });
});
