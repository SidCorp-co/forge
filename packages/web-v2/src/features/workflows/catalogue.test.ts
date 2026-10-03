import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { describe, expect, it } from "vitest";
import hop from "./c4/hop-system-context.fixture.json";
import { catalogue, mainJourneyOf, purposeOf, systemContextOf, systemOverview, templateTitle } from "./catalogue";
import type { DesignStatus, WorkflowBody, WorkflowRecord } from "./types";

const record = (flow: string, template: string | null, status: DesignStatus | null, updatedAt: string, steps = 3, kind: "flow" | "state" = "flow"): WorkflowRecord => ({
  revision: 1,
  writer: "u",
  writerName: "BA assistant",
  design: { status, approvedRevision: status === "approved" ? 1 : null },
  document: {
    ...(hop as unknown as WorkflowBody),
    ...(template ? { version: 2 as const, template: { id: template, version: 1 } } : { version: 1 as const, template: undefined }),
    kind,
    flow,
    title: flow,
    steps: (hop as unknown as WorkflowBody).steps.slice(0, steps),
    id: flow,
    createdAt: updatedAt,
    updatedAt,
  },
});

describe("the catalogue", () => {
  it("groups designs by what they are for, never by template id, in reading order", () => {
    const rs = [
      record("flow-a", "operational-flow", "approved", "2026-10-01"),
      record("lifecycle", "state-machine", "proposed", "2026-10-02"),
      record("ctx", "system-context", "proposed", "2026-10-03"),
      record("screens", "ux-flow", "draft", "2026-10-04"),
      record("calls", "integration-sequence", "approved", "2026-10-01"),
      record("data", "data-flow", null, "2026-10-01"),
      record("rule", "decision-model", null, "2026-10-01"),
      record("bp", "service-blueprint-cross-functional", null, "2026-10-01"),
      record("own", "our-own-template", null, "2026-10-01"),
    ];
    const groups = catalogue(rs);
    expect(groups.map((g) => g.label)).toEqual(["System", "Journeys", "Lifecycles", "Integrations", "Data", "Decisions", "Service", "Other"]);
    expect(groups.find((g) => g.id === "journeys")?.rows.map((r) => r.document.flow)).toEqual(["screens", "flow-a"]);
  });

  it("reads a design stored before templates by its kind", () => {
    expect(purposeOf(record("old-state", null, null, "2026-10-01", 3, "state"))).toBe("lifecycles");
    expect(purposeOf(record("old-flow", null, null, "2026-10-01"))).toBe("journeys");
  });

  it("names a template as a person reads it, and spells out one it does not know", () => {
    expect(templateTitle("data-flow", BUILTIN_WORKFLOW_TEMPLATES)).toBe("Data flow");
    expect(templateTitle("our-own_template", [])).toBe("Our own template");
  });
});

describe("the system overview", () => {
  it("draws from an approved system context before a newer proposed one", () => {
    const approved = record("ctx-old", "system-context", "approved", "2026-09-01");
    const proposed = record("ctx-new", "system-context", "proposed", "2026-10-01");
    expect(systemContextOf([proposed, approved])?.document.flow).toBe("ctx-old");
    expect(systemContextOf([proposed])?.document.flow).toBe("ctx-new");
    expect(systemContextOf([record("j", "operational-flow", null, "2026-10-01")])).toBeNull();
  });

  it("points to the largest approved journey as the main one", () => {
    const big = record("big", "operational-flow", "proposed", "2026-10-01", 15);
    const approved = record("approved", "ux-flow", "approved", "2026-10-01", 5);
    expect(mainJourneyOf([big, approved])?.document.flow).toBe("approved");
    expect(mainJourneyOf([big])?.document.flow).toBe("big");
  });

  it("states HOP's facts from its context design: four roles, six outside systems in three boundaries", () => {
    const o = systemOverview([record("hop-system-context", "system-context", "proposed", "2026-10-03", 17)], BUILTIN_WORKFLOW_TEMPLATES);
    expect(o?.facts.map((f) => [f.label, f.value])).toEqual([
      ["Users", "4 roles"],
      ["External systems", "6 in 3 boundaries"],
    ]);
    expect(o?.facts[0]?.tip.split("\n")).toHaveLength(4);
    expect(o?.journey).toBeNull();
  });
});
