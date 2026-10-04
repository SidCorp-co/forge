import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { describe, expect, it } from "vitest";
import hop from "./c4/hop-system-context.fixture.json";
import hopNow from "./c4/hop-system-context-current.fixture.json";
import {
  catalogue,
  describeSystem,
  firstSentence,
  mainJourneyOf,
  purposeOf,
  sensitivityOf,
  systemContextOf,
  systemOverview,
  templateTitle,
} from "./catalogue";
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
    expect(o?.facts[0]?.rows.map((r) => r.name)).toHaveLength(4);
    expect(o?.journey).toBeNull();
  });

  it("breaks HOP's seventeen outside systems down by boundary, in lane order, with how many are unconfirmed", () => {
    const r = record("hop-system-context", "system-context", "approved", "2026-10-04", 31);
    const doc = hopNow as unknown as WorkflowBody;
    const o = systemOverview([{ ...r, document: { ...r.document, ...doc, id: "hop-system-context" } }], BUILTIN_WORKFLOW_TEMPLATES);
    expect(o?.facts[1]?.value).toBe("17 in 4 boundaries");
    const lane = (id: string) => doc.lanes?.find((l) => l.id === id)?.label;
    expect(o?.facts[1]?.rows).toEqual([
      { name: lane("hospital"), count: 9, unconfirmed: 6 },
      { name: lane("partners"), count: 3, unconfirmed: 3 },
      { name: lane("channels"), count: 2, unconfirmed: 0 },
      { name: lane("outside"), count: 3, unconfirmed: 0 },
    ]);
    const role = (id: string) => doc.steps.find((s) => s.id === id)?.node?.label;
    expect(o?.facts[0]?.rows.map((x) => x.name)).toEqual(["staff", "leads", "hospital-it", "patient", "caregiver"].map(role));
  });
});

describe("what the overview says the system is", () => {
  const overview = (summary: string, purpose?: string) => {
    const r = record("hop-system-context", "system-context", "approved", "2026-10-04", 17);
    const steps = r.document.steps.map((s) => (s.id === "hop" && purpose ? { ...s, node: { ...s.node, type: "SYSTEM", purpose } } : s));
    const o = systemOverview([{ ...r, document: { ...r.document, summary, steps } }], BUILTIN_WORKFLOW_TEMPLATES);
    if (!o) throw new Error("no overview");
    return o;
  };
  const provenance = "A Forge record, no source code. Who uses HOP at the hospital and the systems around it.";
  const described = { project: { name: "HOP", description: "HOP is the hospital's operations platform." } };

  it("takes the project's description first", () => {
    expect(describeSystem(described, overview(provenance, "The staff site"))).toEqual({ text: "HOP is the hospital's operations platform.", source: "project" });
  });

  it("takes the in-scope system's stated purpose when the project states no description", () => {
    expect(describeSystem({ project: { name: "HOP" } }, overview(provenance, "The staff site"))).toEqual({ text: "The staff site", source: "purpose" });
  });

  it("falls back to the design summary's first sentence, marked as such, never the whole summary", () => {
    const d = describeSystem(undefined, overview(provenance));
    expect(d).toEqual({ text: "A Forge record, no source code.", source: "summary" });
  });

  it("does not read a step's `does` as the system's purpose", () => {
    const o = overview(provenance);
    expect(o.graph.focal?.purpose).toBe("");
  });

  it("ignores a blank description", () => {
    expect(describeSystem({ project: { description: "   " } }, overview(provenance))?.source).toBe("summary");
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
