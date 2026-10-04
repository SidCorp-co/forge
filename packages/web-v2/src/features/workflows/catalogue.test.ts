import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { describe, expect, it } from "vitest";
import hopJson from "./c4/hop.graph.fixture.json";
import hopNowJson from "./c4/hop-now.graph.fixture.json";
import {
  catalogue,
  describeSystem,
  firstSentence,
  mainJourneyOf,
  overviewFacts,
  purposeOf,
  sensitivityOf,
  systemContextOf,
  systemOverview,
  templateTitle,
} from "./catalogue";
import type { DesignStatus, SystemGraph, WorkflowBody, WorkflowRecord, WorkflowStep } from "./types";

// Core's read model of HOP's system context at rev 4 and as dev held it on 2026-10-04.
const hop = hopJson as SystemGraph;
const hopNow = hopNowJson as SystemGraph;

const stepsOf = (n: number): WorkflowStep[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, does: `step ${i}`, after: [] }));

const body: WorkflowBody = {
  version: 2,
  project: "p",
  flow: "f",
  kind: "flow",
  title: "f",
  summary: "A design.",
  steps: [],
  writtenBy: {},
};

const record = (flow: string, template: string | null, status: DesignStatus | null, updatedAt: string, steps = 3, kind: "flow" | "state" = "flow"): WorkflowRecord => ({
  revision: 1,
  writer: "u",
  writerName: "BA assistant",
  design: { status, approvedRevision: status === "approved" ? 1 : null },
  document: {
    ...body,
    ...(template ? { version: 2 as const, template: { id: template, version: 1 } } : { version: 1 as const, template: undefined }),
    kind,
    flow,
    title: flow,
    steps: stepsOf(steps),
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

  it("states HOP's facts as core counted them: four roles, six outside systems in three boundaries", () => {
    const facts = overviewFacts(hop);
    expect(facts.map((f) => [f.label, f.value])).toEqual([
      ["Users", "4 roles"],
      ["External systems", "6 in 3 boundaries"],
    ]);
    expect(facts[0]?.rows).toHaveLength(4);
    expect(systemOverview([record("hop-system-context", "system-context", "proposed", "2026-10-03", 17)])?.journey).toBeNull();
  });

  it("shows HOP's seventeen outside systems by boundary, as core broke them down", () => {
    const facts = overviewFacts(hopNow);
    expect(facts[1]?.value).toBe("17 in 4 boundaries");
    expect(facts[1]?.rows).toEqual(hopNow.facts.boundaries);
  });

  it("says one role, and no boundary count for one boundary", () => {
    const facts = overviewFacts({ ...hop, facts: { people: [{ name: "Nurse" }], externals: 2, boundaries: [], namedBoundaries: 1 } });
    expect(facts.map((f) => f.value)).toEqual(["1 role", "2"]);
  });
});

describe("what the overview says the system is", () => {
  const overview = (summary: string) => {
    const r = record("hop-system-context", "system-context", "approved", "2026-10-04", 17);
    const o = systemOverview([{ ...r, document: { ...r.document, summary } }]);
    if (!o) throw new Error("no overview");
    return o;
  };
  const graph = (purpose = "") => ({ ...hop, focal: hop.focal && { ...hop.focal, purpose } });
  const provenance = "A Forge record, no source code. Who uses HOP at the hospital and the systems around it.";
  const described = { project: { name: "HOP", description: "HOP is the hospital's operations platform." } };

  it("takes the project's description first", () => {
    expect(describeSystem(described, overview(provenance), graph("The staff site"))).toEqual({ text: "HOP is the hospital's operations platform.", source: "project" });
  });

  it("takes the in-scope system's stated purpose when the project states no description", () => {
    expect(describeSystem({ project: { name: "HOP" } }, overview(provenance), graph("The staff site"))).toEqual({ text: "The staff site", source: "purpose" });
  });

  it("falls back to the design summary's first sentence, marked as such, never the whole summary", () => {
    const d = describeSystem(undefined, overview(provenance), graph());
    expect(d).toEqual({ text: "A Forge record, no source code.", source: "summary" });
  });

  it("falls back to the summary while the graph is not read yet", () => {
    expect(describeSystem(undefined, overview(provenance), null)?.source).toBe("summary");
  });

  it("ignores a blank description", () => {
    expect(describeSystem({ project: { description: "   " } }, overview(provenance), graph())?.source).toBe("summary");
  });

  it.each([
    ["One. Two.", "One."],
    ["No stop at all", "No stop at all"],
    ["v2.1 ships. Then more.", "v2.1 ships."],
    ["Why? Because.", "Why?"],
  ])("first sentence of %s", (text, first) => {
    expect(firstSentence(text)).toBe(first);
  });
});

describe("the data policy fact", () => {
  it("shows a restricting level and nothing for an absent or open one", () => {
    expect(sensitivityOf({ sensitiveData: "no_egress" })).toBe("no_egress");
    expect(sensitivityOf({ sensitiveData: "redact" })).toBe("redact");
    expect(sensitivityOf({ sensitiveData: "off" })).toBeNull();
    expect(sensitivityOf({ project: { name: "x" } })).toBeNull();
    expect(sensitivityOf(undefined)).toBeNull();
  });
});
