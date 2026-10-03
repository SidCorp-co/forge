import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { describe, expect, it } from "vitest";
import { templateFor } from "../canvas/model";
import type { WorkflowBody, WorkflowStep } from "../types";
import { layoutContainers } from "./container-layout";
import { layoutContext } from "./context-layout";
import type { Diagram, Pt, Rect } from "./geometry";
import hop from "./hop-system-context.fixture.json";
import { FOCAL, readC4, shortLabel } from "./model";

// The HOP system-context design as dev stores it at rev 4: 17 steps (4 people, 4 systems, 6 containers
// and the site, in five boundaries) and 24 lines.
const hopDoc = hop as unknown as WorkflowBody;
const template = templateFor(hopDoc, BUILTIN_WORKFLOW_TEMPLATES);

function cross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) && ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6));
}

/** Every pair of drawn lines that cross, by id. */
function crossings(d: Diagram): string[] {
  const out: string[] = [];
  for (let i = 0; i < d.lines.length; i++) {
    for (let j = i + 1; j < d.lines.length; j++) {
      const a = d.lines[i]?.samples ?? [];
      const b = d.lines[j]?.samples ?? [];
      let hit = false;
      for (let p = 1; p < a.length && !hit; p++) {
        for (let q = 1; q < b.length && !hit; q++) {
          hit = cross(a[p - 1] as Pt, a[p] as Pt, b[q - 1] as Pt, b[q] as Pt);
        }
      }
      if (hit) out.push(`${d.lines[i]?.id} × ${d.lines[j]?.id}`);
    }
  }
  return out;
}

/** Liang–Barsky: does the segment enter the rectangle's interior (shrunk by 2px, so touching a side is not entering)? */
function enters(a: Pt, b: Pt, r: Rect): boolean {
  const x0 = r.x + 2;
  const x1 = r.x + r.w - 2;
  const y0 = r.y + 2;
  const y1 = r.y + r.h - 2;
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

/** Every line that passes through a box, its own two ends included. */
function throughBoxes(d: Diagram): string[] {
  const out: string[] = [];
  for (const l of d.lines) {
    for (const b of d.boxes) {
      for (let i = 1; i < l.samples.length; i++) {
        if (enters(l.samples[i - 1] as Pt, l.samples[i] as Pt, b)) {
          out.push(`${l.id} through ${b.id}`);
          break;
        }
      }
    }
  }
  return out;
}

const step = (id: string, type: string, band: string | null, after: string[] = []): WorkflowStep => ({
  id,
  title: id,
  does: id,
  status: "designed",
  after,
  evidence: null,
  node: { type, label: id, ...(band ? { band } : {}), ...(type === "SYSTEM" ? { owner: "someone" } : {}) },
});

const design = (steps: WorkflowStep[], edges: WorkflowBody["edges"] = []): WorkflowBody => ({
  ...hopDoc,
  steps,
  edges: edges.length ? edges : steps.flatMap((s) => s.after.map((a) => ({ from: a, to: s.id, label: `${a} to ${s.id}` }))),
  lanes: [
    { id: "people", label: "People" },
    { id: "ours", label: "Our product" },
    { id: "them", label: "Partners" },
  ],
});

describe("reading a system-context design as C4", () => {
  it("finds HOP's boundary as the system in scope, with its six containers and the site inside", () => {
    const m = readC4(hopDoc, template);
    expect(template?.id).toBe("system-context");
    expect(m.focal?.lane).toBe("hop");
    expect(m.focal?.title).toBe(hopDoc.lanes?.find((l) => l.id === "hop")?.label);
    expect(m.focal?.parts.map((p) => p.id).sort()).toEqual(["evaluate", "hop", "hop-db", "intake", "record-action", "retention", "sweep"]);
    expect(m.people.map((p) => p.id)).toEqual(["staff", "leads", "patient", "caregiver"]);
    expect(m.externals.map((x) => x.id).sort()).toEqual(["forge", "his", "llm", "records-policy", "scheduling", "zalo"]);
  });

  it("lifts every line that touches a container to the system and merges each pair once (implied relationships)", () => {
    const m = readC4(hopDoc, template);
    const toScheduling = m.relations.find((r) => [r.from, r.to].sort().join() === [FOCAL, "scheduling"].sort().join());
    expect(toScheduling?.src.map((e) => e.from).sort()).toEqual(["evaluate", "intake", "record-action"]);
    expect(m.relations.every((r) => r.from !== r.to)).toBe(true);
    // the lines that stay inside the system are not drawn on Context
    const kept = m.relations.reduce((n, r) => n + r.src.length, 0);
    const insideOnly = m.canvas.edges.filter((e) => m.focal?.parts.some((p) => p.id === e.from) && m.focal?.parts.some((p) => p.id === e.to));
    expect(kept + insideOnly.length).toBe(m.canvas.edges.length);
  });

  it("takes the most connected system as the one in scope when the design draws no container", () => {
    const m = readC4(design([step("a", "PERSON", "people"), step("core", "SYSTEM", "ours", ["a"]), step("bank", "SYSTEM", "them", ["core"])]), template);
    expect(m.focal?.parts.map((p) => p.id)).toEqual(["core"]);
    expect(m.externals.map((x) => x.id)).toEqual(["bank"]);
  });

  it("draws no Context for a design with no system at all", () => {
    const m = readC4(design([step("a", "PERSON", "people"), step("b", "PERSON", "people", ["a"])]), template);
    expect(m.focal).toBeNull();
    expect(layoutContext(m)).toBeNull();
  });
});

describe("the Context layout (C4 level 1)", () => {
  it("draws a plain 3-column context with no crossing and people | system | external in order", () => {
    const m = readC4(
      design([
        step("p1", "PERSON", "people"),
        step("p2", "PERSON", "people"),
        step("web", "CONTAINER", "ours", ["p1", "p2"]),
        step("db", "CONTAINER", "ours", ["web"]),
        step("x1", "SYSTEM", "them", ["web"]),
        step("x2", "SYSTEM", "them", ["db"]),
        step("x3", "SYSTEM", "them"),
        step("feed", "CONTAINER", "ours", ["x3"]),
      ]),
      template,
    );
    const d = layoutContext(m) as Diagram;
    expect(crossings(d)).toEqual([]);
    expect(throughBoxes(d)).toEqual([]);
    const x = (id: string) => d.boxes.find((b) => b.id === id)?.x ?? Number.NaN;
    expect(x("p1")).toBeLessThan(x(FOCAL));
    expect(x(FOCAL)).toBeLessThan(x("x1"));
    expect(d.boxes.filter((b) => b.kind === "focal")).toHaveLength(1);
    expect(d.lines).toHaveLength(5);
  });

  it("routes a person-to-outside line around the system box instead of across it", () => {
    const m = readC4(
      design([
        step("staff", "PERSON", "people"),
        step("app", "CONTAINER", "ours", ["staff"]),
        step("crm", "SYSTEM", "them", ["app", "staff"]),
        step("sms", "SYSTEM", "them", ["app"]),
        step("patient", "PERSON", "people", ["sms"]),
      ]),
      template,
    );
    const d = layoutContext(m) as Diagram;
    expect(crossings(d)).toEqual([]);
    expect(throughBoxes(d)).toEqual([]);
  });

  it("draws HOP's context with no line crossing another and none through a box", () => {
    const d = layoutContext(readC4(hopDoc, template)) as Diagram;
    expect(d.boxes).toHaveLength(11);
    expect(crossings(d)).toEqual([]);
    expect(throughBoxes(d)).toEqual([]);
    for (const b of d.boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(d.width);
      expect(b.y + b.h).toBeLessThanOrEqual(d.height);
    }
  });

  it("keeps every label on the canvas short, the full words in the tooltip", () => {
    const d = layoutContext(readC4(hopDoc, template)) as Diagram;
    for (const l of d.lines) {
      expect(l.label.length).toBeLessThanOrEqual(40);
      expect(l.tip.length).toBeGreaterThanOrEqual(l.label.replace(/ \+\d+$/, "").replace(/…$/, "").length);
    }
    // HIS's one line carries a long label with an aside; the canvas keeps the clause before it, the tooltip the whole
    const full = hopDoc.edges?.find((e) => e.from === "his")?.label ?? "";
    const his = d.lines.find((l) => l.ends.includes("his"));
    expect(full.length).toBeGreaterThan(40);
    expect(full.startsWith(his?.label ?? "-")).toBe(true);
    expect(his?.label.length).toBeLessThan(full.indexOf("("));
    expect(his?.tip).toContain(full);
  });

  it("lays out the same design to the same picture every time", () => {
    const a = layoutContext(readC4(hopDoc, template));
    const b = layoutContext(readC4(structuredClone(hopDoc), template));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("the Containers layout (C4 level 2)", () => {
  it("puts HOP's parts inside the boundary, people left of it and outside systems right of it", async () => {
    const d = (await layoutContainers(readC4(hopDoc, template))) as Diagram;
    const b = d.boundary as Rect;
    expect(b).not.toBeNull();
    const box = (id: string) => d.boxes.find((x) => x.id === id) as Rect;
    for (const id of ["intake", "evaluate", "record-action", "sweep", "retention", "hop-db", "hop"]) {
      const r = box(id);
      expect(r.x >= b.x && r.y >= b.y && r.x + r.w <= b.x + b.w && r.y + r.h <= b.y + b.h).toBe(true);
    }
    for (const id of ["staff", "leads", "patient", "caregiver"]) expect(box(id).x + box(id).w).toBeLessThanOrEqual(b.x);
    for (const id of ["his", "scheduling", "records-policy", "zalo", "forge", "llm"]) expect(box(id).x).toBeGreaterThanOrEqual(b.x + b.w);
    expect(d.lines).toHaveLength(24);
  });

  it("keeps the people in one column and the outside systems in one, the lines between them drawn as brackets", async () => {
    const d = (await layoutContainers(readC4(hopDoc, template))) as Diagram;
    const xs = (ids: string[]) => new Set(ids.map((id) => d.boxes.find((b) => b.id === id)?.x));
    expect(xs(["staff", "leads", "patient", "caregiver"]).size).toBe(1);
    expect(xs(["his", "scheduling", "records-policy", "zalo", "forge", "llm"]).size).toBe(1);
    const call = d.lines.find((l) => l.id === "staff>patient");
    expect(call?.anchor).toBe("end");
    expect(throughBoxes(d)).toEqual([]);
  });
});

describe("shortLabel", () => {
  it("keeps the clause before the first aside", () => {
    expect(shortLabel("Sends the discharge (signed), answers read requests")).toBe("Sends the discharge");
  });
  it("cuts a long clause at a word, with an ellipsis", () => {
    const s = shortLabel("Reads every upcoming appointment for the patient across all clinics", 30);
    expect(s.length).toBeLessThanOrEqual(30);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toBe("Reads every upcoming…");
  });
  it("leaves a short label alone", () => {
    expect(shortLabel("Calls the patient")).toBe("Calls the patient");
  });
});
