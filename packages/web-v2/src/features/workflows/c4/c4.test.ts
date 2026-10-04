import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { describe, expect, it } from "vitest";
import { templateFor } from "../canvas/model";
import type { WorkflowBody, WorkflowStep } from "../types";
import forge from "./forge-system-context.fixture.json";
import { integrationOf, readSystemGraph } from "./graph";
import hop from "./hop-system-context.fixture.json";
import hopNow from "./hop-system-context-current.fixture.json";
import { type Diagram, layoutView, type Pt, type Rect, shortLabel } from "./layout";
import { type Detail, FOCAL, type Level, PEOPLE_AT_A_GLANCE, viewOf } from "./view";

// HOP's system-context design at rev 4 (17 steps, 24 lines), HOP's as dev holds it now (31 steps: 17
// outside systems in four boundaries, five people) and forge's onboarding draft (22 steps).
const doc = (j: unknown) => j as WorkflowBody;
const template = templateFor(doc(hop), BUILTIN_WORKFLOW_TEMPLATES);
const graphOf = (j: unknown) => readSystemGraph(doc(j), template);

const step = (id: string, type: string, band: string | null, after: string[] = []): WorkflowStep => ({
  id,
  title: id,
  does: id,
  status: "designed",
  after,
  evidence: null,
  node: { type, label: id, ...(band ? { band } : {}), ...(type === "SYSTEM" ? { owner: "someone" } : {}) },
});

const design = (steps: WorkflowStep[]): WorkflowBody => ({
  ...doc(hop),
  steps,
  edges: steps.flatMap((s) => s.after.map((a) => ({ from: a, to: s.id, label: `${a} to ${s.id}` }))),
  lanes: [
    { id: "people", label: "People" },
    { id: "ours", label: "Our product" },
    { id: "them", label: "Partners" },
  ],
});

/** Liang–Barsky: does the segment enter the rectangle's interior (shrunk by 2px, so touching a side is not entering)? */
function enters(a: Pt, b: Pt, r: Rect): boolean {
  const [x0, x1, y0, y1] = [r.x + 2, r.x + r.w - 2, r.y + 2, r.y + r.h - 2];
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;

/** Every way a diagram breaks the drawing rules, named. */
function defects(d: Diagram): string[] {
  const out: string[] = [];
  const rect = new Map(d.boxes.map((b) => [b.node.id, b]));
  for (const l of d.lines) {
    for (const b of d.boxes) {
      for (let i = 1; i < l.points.length; i++) {
        if (enters(l.points[i - 1] as Pt, l.points[i] as Pt, b)) {
          out.push(`${l.id} through ${b.node.id}`);
          break;
        }
      }
    }
    // A line runs between its two ends: it never detours past either of them round the diagram.
    const [a, z] = l.ends.map((id) => rect.get(id) as Rect) as [Rect, Rect];
    const lo = Math.min(a.x, z.x) - 1;
    const hi = Math.max(a.x + a.w, z.x + z.w) + 1;
    if (l.points.some((p) => p.x < lo || p.x > hi)) out.push(`${l.id} wraps past its ends`);
    if (!l.label) continue;
    for (const o of d.lines) if (o !== l && o.label && o.id < l.id && overlaps(l.label, o.label)) out.push(`${l.id} label over ${o.id} label`);
    for (const b of d.boxes) if (overlaps(l.label, b)) out.push(`${l.id} label over ${b.node.id}`);
  }
  return out;
}

const VIEWS: [Level, Detail][] = [
  ["context", "boundaries"],
  ["context", "systems"],
  ["containers", "boundaries"],
  ["containers", "systems"],
];

describe("design document → system graph", () => {
  it("finds HOP's boundary as the system in scope, with its containers and the site inside", () => {
    const g = graphOf(hop);
    expect(g.focal?.boundary).toBe("hop");
    expect(g.focal?.title).toBe(doc(hop).lanes?.find((l) => l.id === "hop")?.label);
    expect(g.focal?.parts.sort()).toEqual(["evaluate", "hop", "hop-db", "intake", "record-action", "retention", "sweep"]);
    expect(g.nodes.filter((n) => n.kind === "person").map((n) => n.id)).toEqual(["staff", "leads", "patient", "caregiver"]);
    expect(g.nodes.filter((n) => n.kind === "external").map((n) => n.id).sort()).toEqual(["forge", "his", "llm", "records-policy", "scheduling", "zalo"]);
  });

  it("keeps every relationship of the design with its own label and technology", () => {
    const g = graphOf(forge);
    expect(g.relationships).toHaveLength(27);
    expect(g.relationships.find((r) => r.id === "member>runner")).toMatchObject({ label: "pairs the box, binds repos", technology: "forge-runner CLI" });
  });

  it("splits each lane into boundaries by side and counts the header facts once", () => {
    const g = graphOf(hopNow);
    expect(g.boundaries.map((b) => b.id)).toEqual(["people:people", "outside:hospital", "focal:hop", "outside:partners", "outside:channels", "outside:outside"]);
    expect(g.facts.externals).toBe(17);
    expect(g.facts.namedBoundaries).toBe(4);
    expect(g.facts.people).toHaveLength(5);
  });

  it("takes the most connected system as the one in scope when the design draws no container", () => {
    const g = readSystemGraph(design([step("a", "PERSON", "people"), step("core", "SYSTEM", "ours", ["a"]), step("bank", "SYSTEM", "them", ["core"])]), template);
    expect(g.focal?.parts).toEqual(["core"]);
    expect(g.nodes.find((n) => n.id === "bank")?.kind).toBe("external");
  });

  it("has no view for a design with no system at all", () => {
    const g = readSystemGraph(design([step("a", "PERSON", "people"), step("b", "PERSON", "people", ["a"])]), template);
    expect(g.focal).toBeNull();
    expect(viewOf(g, "context", "systems")).toBeNull();
  });
});

describe("graph → view", () => {
  it("lifts every line that touches the system's parts to the system box, merging each pair once", () => {
    const g = graphOf(hop);
    const v = viewOf(g, "context", "systems");
    const toScheduling = v?.edges.find((e) => [e.from, e.to].sort().join() === [FOCAL, "scheduling"].sort().join());
    expect(toScheduling?.rels.map((r) => r.from).sort()).toEqual(["evaluate", "intake", "record-action"]);
    const drawn = v?.edges.reduce((n, e) => n + e.rels.length, 0) ?? 0;
    const inside = g.relationships.filter((r) => g.focal?.parts.includes(r.from) && g.focal.parts.includes(r.to));
    expect(drawn + inside.length).toBe(g.relationships.length);
  });

  it("folds each outside boundary of two or more into one box named for the boundary, with its count", () => {
    const v = viewOf(graphOf(hopNow), "context", "boundaries");
    const groups = v?.nodes.filter((n) => n.kind === "group") ?? [];
    expect(Object.fromEntries(groups.map((n) => [n.id, n.count]))).toEqual({ "people:people": 5, "outside:hospital": 9, "outside:partners": 3, "outside:channels": 2, "outside:outside": 3 });
    expect(groups.find((n) => n.id === "outside:hospital")?.name).toBe(doc(hopNow).lanes?.find((l) => l.id === "hospital")?.label);
  });

  it("keeps a few people one by one, and folds them only past PEOPLE_AT_A_GLANCE", () => {
    const v = viewOf(graphOf(forge), "context", "boundaries");
    expect(v?.nodes.filter((n) => n.kind === "person").map((n) => n.id)).toEqual(["member", "operator"]);
    expect(graphOf(hopNow).facts.people.length).toBeGreaterThan(PEOPLE_AT_A_GLANCE);
  });

  it("draws every system inside a frame per boundary, and opens the system into its parts at Containers", () => {
    const v = viewOf(graphOf(hopNow), "containers", "systems");
    expect(v?.frames.map((f) => f.id).sort()).toEqual([FOCAL, "outside:channels", "outside:hospital", "outside:outside", "outside:partners"]);
    expect(v?.nodes.filter((n) => n.frame === FOCAL)).toHaveLength(graphOf(hopNow).focal?.parts.length ?? -1);
    expect(v?.nodes.some((n) => n.kind === "focal")).toBe(false);
  });

  it("opens one boundary the viewer asked for, leaving the rest folded", () => {
    const v = viewOf(graphOf(hopNow), "context", "boundaries", new Set(["outside:hospital"]));
    expect(v?.frames.find((f) => f.id === "outside:hospital")?.folds).toBe(true);
    expect(v?.nodes.filter((n) => n.frame === "outside:hospital")).toHaveLength(9);
    expect(v?.nodes.find((n) => n.id === "outside:partners")?.kind).toBe("group");
  });
});

describe("view → layout", () => {
  it.each([
    ["HOP", hopNow],
    ["forge", forge],
    ["HOP rev 4", hop],
  ])("%s: no line through a box, none wrapping past its ends, no label over a label or a box, in every view", async (_name, j) => {
    const g = graphOf(j);
    for (const [level, detail] of VIEWS) {
      const d = await layoutView(viewOf(g, level, detail) as NonNullable<ReturnType<typeof viewOf>>);
      expect(defects(d), `${level} / ${detail}`).toEqual([]);
    }
  });

  it("labels a line with its relationship's own words, a merged line with the first and how many more", async () => {
    const d = await layoutView(viewOf(graphOf(forge), "context", "boundaries") as NonNullable<ReturnType<typeof viewOf>>);
    const pairs = d.lines.find((l) => l.ends.includes("member") && l.ends.includes("outside:box"));
    expect(pairs?.label).toMatchObject({ text: "pairs the box", more: 0 });
    const outside = d.lines.find((l) => l.ends.includes(FOCAL) && l.ends.includes("outside:outside"));
    expect(outside?.label?.more).toBe((outside?.edge.rels.length ?? 0) - 1);
    expect(outside?.label?.text).toBe(shortLabel(outside?.edge.rels[0]?.label ?? "-"));
    expect(d.lines.every((l) => !/\blinks?\b/.test(l.label?.text ?? ""))).toBe(true);
  });

  it("points the arrowheads the way the design's lines run, whichever end the layout starts from", async () => {
    const d = await layoutView(viewOf(graphOf(hopNow), "context", "systems") as NonNullable<ReturnType<typeof viewOf>>);
    const zns = d.lines.find((l) => l.ends.includes("zalo") && l.ends.includes("patient"));
    expect(zns?.ends).toEqual(["patient", "zalo"]);
    expect(zns).toMatchObject({ arrowStart: true, arrowEnd: false });
  });

  it("lays out the same view to the same picture every time", async () => {
    const a = await layoutView(viewOf(graphOf(hopNow), "context", "boundaries") as NonNullable<ReturnType<typeof viewOf>>);
    const b = await layoutView(viewOf(readSystemGraph(structuredClone(doc(hopNow)), template), "context", "boundaries") as NonNullable<ReturnType<typeof viewOf>>);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("reading an outside system's integration state from its label", () => {
  it.each([
    ["EMR (chưa xác nhận tích hợp)", "EMR", "unconfirmed"], // i18n-allow: a label as HOP's design writes it
    ["SMS (đề xuất, chưa xác nhận)", "SMS", "unconfirmed"], // i18n-allow: a label as HOP's design writes it
    ["Partner / Referral systems (chưa xác nhận)", "Partner / Referral systems", "unconfirmed"], // i18n-allow: a label as HOP's design writes it
    ["Billing (proposed)", "Billing", "unconfirmed"],
    ["HIS / EMR", "HIS / EMR", "confirmed"],
    ["LLM, embedding, BA assistant (ở nước ngoài)", "LLM, embedding, BA assistant (ở nước ngoài)", "confirmed"], // i18n-allow: an aside that is not about confirmation
  ])("%s", (title, name, state) => {
    expect(integrationOf(title)).toMatchObject({ name, state });
  });
});

describe("shortLabel", () => {
  it("keeps the clause before the first aside", () => {
    expect(shortLabel("Sends the discharge (signed), answers read requests")).toBe("Sends the discharge");
  });
  it("cuts a long clause at a word, with an ellipsis", () => {
    const s = shortLabel("Reads every upcoming appointment for the patient across all clinics", 30);
    expect(s.length).toBeLessThanOrEqual(30);
    expect(s).toBe("Reads every upcoming…");
  });
  it("leaves a short label alone", () => {
    expect(shortLabel("Calls the patient")).toBe("Calls the patient");
  });
});
