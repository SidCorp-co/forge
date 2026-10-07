import {
  LEGACY_V2_TEMPLATE,
  lineKindOf,
  type TemplateEdgeKind,
  type TemplateNodeType,
  type WorkflowTemplate,
} from "@forge/contracts/workflow-templates";
import { useMemo } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { WorkflowBody, WorkflowEdgeContract, WorkflowStep } from "../types";

/** A line the canvas draws: an `after` line (with its contract, if the design gives one) or a return edge. */
export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  kind: TemplateEdgeKind;
  contract: WorkflowEdgeContract | null;
}

export interface CanvasBand {
  id: string;
  label: string;
  tooltip: string;
  steps: string[];
}

/** A design read through its template: every step's type and band, every line's kind. */
export interface Canvas {
  doc: Pick<WorkflowBody, "title" | "summary" | "kind" | "steps" | "edges" | "flow">;
  template: WorkflowTemplate | null;
  /** Rows drawn behind the cards; empty for a template that is not a layered-bands one. */
  bands: CanvasBand[];
  bandOf: Map<string, string>;
  steps: Map<string, WorkflowStep>;
  typeOf: (id: string) => TemplateNodeType;
  /** The design's own lane a step sits in, for a template whose lanes come from the design. */
  laneOf: (id: string) => string | null;
  edges: CanvasEdge[];
}

/** The line a template does not name, in the interface language. */
const genericKind = (t: Copy): TemplateEdgeKind => ({
  id: "flow",
  label: t("workflows.canvas.flowKind"),
  tooltip: t("workflows.canvas.flowKindHint"),
  direction: "forward",
  required: [],
  line: "solid",
  colour: "neutral",
});

const genericType = (id: string): TemplateNodeType => ({
  id,
  label: id.charAt(0) + id.slice(1).toLowerCase().replaceAll("_", " "),
  tooltip: id,
  icon: "circle",
  colour: "slate",
  required: [],
});

/** The template a stored design is read in: the one it names, or operational-flow@1 for one written before templates. */
export function templateFor(
  doc: Pick<WorkflowBody, "version" | "template">,
  templates: readonly WorkflowTemplate[],
): WorkflowTemplate | null {
  if (doc.version !== 2) return null;
  const ref = doc.template ?? LEGACY_V2_TEMPLATE;
  return templates.find((t) => t.id === ref.id && t.version === ref.version) ?? null;
}

/** `readCanvas` in the interface language, read again only when the design, its template or the language changes. */
export function useCanvasModel(doc: Canvas["doc"], template: WorkflowTemplate | null): Canvas {
  const t = useCopy();
  return useMemo(() => readCanvas(doc, template, t), [doc, template, t]);
}

export function readCanvas(doc: Canvas["doc"], template: WorkflowTemplate | null, t: Copy): Canvas {
  const GENERIC_KIND = genericKind(t);
  const steps = new Map(doc.steps.map((s) => [s.id, s]));
  const types = new Map((template?.nodeTypes ?? []).map((t) => [t.id, t]));
  const typeOf = (id: string) => {
    const type = steps.get(id)?.node?.type ?? template?.defaultNodeType ?? "STEP";
    return types.get(type) ?? genericType(type);
  };
  const kinds = new Map((template?.edgeKinds ?? []).map((k) => [k.id, k]));
  const kindOf = (named: string | undefined, from: string, to: string) => {
    const implied = template && !named ? lineKindOf(template, typeOf(from).id, typeOf(to).id) : null;
    const id = named ?? (implied && "kind" in implied ? implied.kind : undefined);
    return (id && kinds.get(id)) || GENERIC_KIND;
  };
  const contracts = new Map((doc.edges ?? []).map((e) => [`${e.from}>${e.to}`, e]));
  const edges: CanvasEdge[] = [];
  for (const s of doc.steps) {
    for (const a of s.after) {
      if (!steps.has(a)) continue;
      const contract = contracts.get(`${a}>${s.id}`) ?? null;
      edges.push({ id: `${a}>${s.id}`, from: a, to: s.id, kind: kindOf(contract?.kind, a, s.id), contract });
    }
  }
  for (const e of doc.edges ?? []) {
    const kind = kindOf(e.kind, e.from, e.to);
    if (kind.direction !== "return" || !steps.has(e.from) || !steps.has(e.to)) continue;
    edges.push({ id: `${e.from}>${e.to}`, from: e.from, to: e.to, kind, contract: e });
  }
  const banded = template?.layout.family === "layered-bands" && template.lanes.from === "template";
  const bandRows = banded && template.lanes.from === "template" ? template.lanes.bands : [];
  const bandOf = new Map<string, string>();
  for (const s of doc.steps) {
    const home = typeOf(s.id).band;
    const band = s.node?.band ?? home ?? bandRows.find((b) => b.types.includes(typeOf(s.id).id))?.id;
    if (band) bandOf.set(s.id, band);
  }
  const bands = bandRows.map((b) => ({
    id: b.id,
    label: b.label,
    tooltip: b.tooltip,
    steps: doc.steps.filter((s) => bandOf.get(s.id) === b.id).map((s) => s.id),
  }));
  const placed = new Set(bands.flatMap((b) => b.steps));
  const stray = doc.steps.filter((s) => !placed.has(s.id)).map((s) => s.id);
  if (banded && stray.length > 0) {
    bands.push({ id: "__unplaced", label: t("workflows.canvas.unplaced"), tooltip: t("workflows.canvas.unplacedHint"), steps: stray });
    for (const id of stray) bandOf.set(id, "__unplaced");
  }
  const lanes = new Map(
    (template?.lanes.from === "design" ? ((doc as WorkflowBody).lanes ?? []) : []).map((l) => [l.id, l.label]),
  );
  return {
    doc,
    template,
    bands: bands.filter((b) => b.steps.length > 0),
    bandOf,
    steps,
    typeOf,
    laneOf: (id) => lanes.get(steps.get(id)?.node?.band ?? "") ?? null,
    edges,
  };
}

/** The words an approver reads; the canvas renders what the design says and invents none. */
export const titleOf = (s: WorkflowStep) => s.node?.label ?? s.title ?? s.id;
export const purposeOf = (s: WorkflowStep) => s.node?.purpose ?? s.does;
export const edgeText = (e: CanvasEdge) => e.contract?.label ?? e.contract?.condition ?? "";

const LINE_WORDS = 48;

/** A line's words on the canvas: its business label, else its condition cut short; `full` is the untrimmed text for the tooltip. */
export function lineLabel(e: CanvasEdge): { text: string; full: string | null } {
  const label = e.contract?.label;
  if (label) return { text: label, full: e.contract?.condition ?? null };
  const cond = e.contract?.condition ?? "";
  if (cond.length <= LINE_WORDS) return { text: cond, full: null };
  return { text: `${cond.slice(0, LINE_WORDS - 1).trimEnd()}…`, full: cond };
}

/** The order a walk-through tells the story in: every step after the ones it comes after, ties in the design's order. */
export function walkOrder(c: Canvas): string[] {
  const order = c.doc.steps.map((s) => s.id);
  const index = new Map(order.map((id, i) => [id, i]));
  const waiting = new Map(c.doc.steps.map((s) => [s.id, s.after.filter((a) => c.steps.has(a)).length]));
  const ready = order.filter((id) => waiting.get(id) === 0);
  const out: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    const next = ready.shift() as string;
    out.push(next);
    for (const s of c.doc.steps) {
      if (!s.after.includes(next)) continue;
      const left = (waiting.get(s.id) ?? 0) - 1;
      waiting.set(s.id, left);
      if (left === 0) ready.push(s.id);
    }
  }
  return [...out, ...order.filter((id) => !out.includes(id))];
}

/** Upstream and downstream along the solid forward lines; a dashed side channel (an escalation) does not extend the path. */
export function pathOf(c: Canvas, id: string): { nodes: Set<string>; edges: Set<string> } {
  const main = c.edges.filter((e) => e.kind.direction === "forward" && e.kind.line === "solid");
  const up = new Set([id]);
  const down = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of main) {
      if (up.has(e.to) && !up.has(e.from)) {
        up.add(e.from);
        grew = true;
      }
      if (down.has(e.from) && !down.has(e.to)) {
        down.add(e.to);
        grew = true;
      }
    }
  }
  const nodes = new Set([...up, ...down]);
  const edges = new Set<string>();
  for (const e of c.edges) {
    const along = (up.has(e.from) && up.has(e.to)) || (down.has(e.from) && down.has(e.to));
    if (along || e.from === id || e.to === id) {
      edges.add(e.id);
      nodes.add(e.from);
      nodes.add(e.to);
    }
  }
  return { nodes, edges };
}

export function searchSteps(c: Canvas, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return c.doc.steps
    .filter((s) => {
      const n = s.node;
      const hay = [
        titleOf(s),
        purposeOf(s),
        s.title,
        s.id,
        n?.owner,
        c.typeOf(s.id).label,
        ...(n?.conditions ?? []).map((r) => `${r.when} ${r.result}`),
      ];
      return hay.join(" ").toLowerCase().includes(q);
    })
    .map((s) => s.id);
}

export interface BandSummary {
  count: number;
  types: { type: TemplateNodeType; count: number }[];
  owners: number;
  deadlines: number;
}

export function bandSummary(c: Canvas, band: CanvasBand): BandSummary {
  const types = new Map<string, { type: TemplateNodeType; count: number }>();
  for (const id of band.steps) {
    const t = c.typeOf(id);
    const seen = types.get(t.id);
    types.set(t.id, { type: t, count: (seen?.count ?? 0) + 1 });
  }
  const nodes = band.steps.map((id) => c.steps.get(id)?.node);
  return {
    count: band.steps.length,
    types: [...types.values()],
    owners: new Set(nodes.map((n) => n?.owner).filter(Boolean)).size,
    deadlines: nodes.filter((n) => n?.sla).length,
  };
}
