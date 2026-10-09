// The requirement picture's reading and its editor's input (REQ-35, ISS-460). The picture, its kind
// and the criterion traces are core's (`RequirementRevision.picture`, `RequirementDetail.traces`);
// this picks the revision shown, groups the traces by the workflow they light, and turns what a
// person typed into the content `PUT …/revisions/:n/picture` takes. Core judges the picture.

import type { ExampleTableContent, PictureKind, RequirementPictureView, WritePictureRequest } from "@forge/contracts/requirement-pictures";
import { VISUAL_BLOCK_VERSION, type VisualBlockOf } from "@forge/contracts/visual-blocks";
import type { RequirementDetail, RequirementRevision } from "./types";

/** The revision the page reads: the current one, else the newest written. */
export const shownRevisionOf = (d: RequirementDetail): RequirementRevision | undefined =>
  d.revisions.find((r) => r.state === "current") ?? d.revisions[0];

/** One linked workflow as the picture draws it: the steps and lines its live criteria trace. */
export interface TracedWorkflow {
  workflowId: string;
  flow: string;
  title: string;
  steps: Set<string>;
  /** Named `from>to`, as the workflow canvas keys a line. */
  edges: Set<string>;
}

/**
 * The linked workflows a process requirement's picture can show, those its live criteria trace
 * first: a trace of a retired criterion lights nothing.
 */
export function tracedWorkflows(d: RequirementDetail): TracedWorkflow[] {
  const live = new Set(d.criteria.map((c) => c.code));
  const by = new Map<string, TracedWorkflow>(
    d.workflows.map((w) => [w.workflowId, { workflowId: w.workflowId, flow: w.flow, title: w.title, steps: new Set(), edges: new Set() }]),
  );
  for (const t of d.traces) {
    const w = by.get(t.workflowId);
    if (!w || !live.has(t.code)) continue;
    for (const s of t.steps) w.steps.add(s);
    for (const e of t.edges) w.edges.add(`${e.from}>${e.to}`);
  }
  const all = [...by.values()];
  const lit = (w: TracedWorkflow) => w.steps.size + w.edges.size > 0;
  return [...all.filter(lit), ...all.filter((w) => !lit(w))];
}

/**
 * A stored picture as the visual-block renderers draw it. It was drawn by hand, so it carries no
 * run's source; the renderers read only its spec and its frame.
 */
export function blockOf<K extends "flow" | "chart" | "table">(kind: K, spec: Record<string, unknown>): VisualBlockOf<K> {
  return { v: VISUAL_BLOCK_VERSION, ...spec, kind } as unknown as VisualBlockOf<K>;
}

type FlowContent = Extract<WritePictureRequest, { kind: "flow" }>["content"];
type ChartContent = Extract<WritePictureRequest, { kind: "chart" }>["content"];

/** Why the flow a person typed cannot be drawn yet, by the line it is on. */
export type FlowFault =
  | { field: "steps"; fault: "none" }
  /** Two lines name the same step, read without case: a link could not say which it means. */
  | { field: "steps"; fault: "repeated"; line: number; name: string }
  | { field: "links"; fault: "notLink" | "unknownStep"; line: number; name?: string };

const ARROW = /^(.+?)\s*->\s*(.+)$/;
const lines = (text: string) => text.split("\n").map((l) => l.trim());

/** A step's id, from its words, unique on the flow. */
function idsFor(labels: readonly string[]): string[] {
  const taken = new Set<string>();
  return labels.map((label, i) => {
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || `step-${i + 1}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  });
}

/**
 * What follows a link's arrow: the step it ends on, then `: label`. A step's own words may hold a
 * colon, so the longest leading part that names a step is the step and the rest its label.
 */
function endOf(rest: string, idOf: ReadonlyMap<string, string>): { id: string; label?: string } | null {
  const cuts = [rest.length, ...[...rest.matchAll(/:/g)].map((m) => m.index).reverse()];
  for (const at of cuts) {
    const id = idOf.get(rest.slice(0, at).trim().toLowerCase());
    if (!id) continue;
    const label = rest.slice(at + 1).trim();
    return label ? { id, label } : { id };
  }
  return null;
}

/** Steps written one per line and links written `From -> To` (`: label` after it), as a flow's content. */
export function flowFromLines(steps: string, links: string, title?: string): { ok: true; content: FlowContent } | { ok: false; fault: FlowFault } {
  const typed = lines(steps);
  const labels = typed.filter(Boolean);
  if (labels.length === 0) return { ok: false, fault: { field: "steps", fault: "none" } };
  const seen = new Set<string>();
  for (const [i, l] of typed.entries()) {
    if (!l) continue;
    if (seen.has(l.toLowerCase())) return { ok: false, fault: { field: "steps", fault: "repeated", line: i + 1, name: l } };
    seen.add(l.toLowerCase());
  }
  const ids = idsFor(labels);
  const idOf = new Map(labels.map((l, i) => [l.toLowerCase(), ids[i] as string]));
  const edges: FlowContent["edges"] = [];
  for (const [i, line] of lines(links).entries()) {
    if (!line) continue;
    const m = ARROW.exec(line);
    if (!m) return { ok: false, fault: { field: "links", fault: "notLink", line: i + 1 } };
    const [, from = "", rest = ""] = m;
    if (!idOf.has(from.toLowerCase())) return { ok: false, fault: { field: "links", fault: "unknownStep", line: i + 1, name: from } };
    const end = endOf(rest, idOf);
    if (!end) return { ok: false, fault: { field: "links", fault: "unknownStep", line: i + 1, name: rest.split(":")[0]?.trim() ?? rest } };
    edges.push({ from: idOf.get(from.toLowerCase()) as string, to: end.id, ...(end.label ? { label: end.label } : {}) });
  }
  return { ok: true, content: { ...(title ? { title } : {}), nodes: labels.map((label, i) => ({ id: ids[i] as string, label })), edges } };
}

/** A stored flow as the lines its editor opens on. */
export function flowToLines(content: FlowContent): { steps: string; links: string } {
  const label = new Map(content.nodes.map((n) => [n.id, n.label]));
  return {
    steps: content.nodes.map((n) => n.label).join("\n"),
    links: content.edges.map((e) => `${label.get(e.from) ?? e.from} -> ${label.get(e.to) ?? e.to}${e.label ? `: ${e.label}` : ""}`).join("\n"),
  };
}

/** A sample chart as its editor holds it: one series of labelled figures. */
export interface ChartDraft {
  variant: "bar" | "line";
  xLabel: string;
  valueLabel: string;
  rows: { label: string; value: string }[];
}

/** A stored chart as its editor opens on it; null where it holds more than one labelled series. */
export function chartDraftOf(content: ChartContent): ChartDraft | null {
  const [y, ...more] = content.y;
  const x = content.frame.fields.find((f) => f.name === content.x);
  const v = content.frame.fields.find((f) => f.name === y);
  if (!y || more.length > 0 || content.series || !x || !v || content.variant === "burndown") return null;
  return {
    variant: content.variant,
    xLabel: x.label,
    valueLabel: v.label,
    rows: content.frame.rows.map((r) => ({ label: String(r[content.x] ?? ""), value: String(r[y] ?? "") })),
  };
}

/** Why a sample chart cannot be drawn yet: an axis left unnamed, no figure, or a row whose figure is not a number. */
export type ChartFault = { field: "xLabel" | "valueLabel" | "rows" } | { field: "row"; row: number };

/** The draft's figures as a chart's content, every one of them sample, or the first thing it lacks. */
export function chartFromDraft(draft: ChartDraft, title?: string): { ok: true; content: ChartContent } | { ok: false; fault: ChartFault } {
  if (!draft.xLabel.trim()) return { ok: false, fault: { field: "xLabel" } };
  if (!draft.valueLabel.trim()) return { ok: false, fault: { field: "valueLabel" } };
  const rows = draft.rows.filter((r) => r.label.trim() || r.value.trim());
  if (rows.length === 0) return { ok: false, fault: { field: "rows" } };
  const bad = rows.findIndex((r) => r.value.trim() === "" || !Number.isFinite(Number(r.value)));
  if (bad >= 0) return { ok: false, fault: { field: "row", row: bad + 1 } };
  return {
    ok: true,
    content: {
      ...(title ? { title } : {}),
      variant: draft.variant,
      x: "label",
      y: ["value"],
      frame: {
        fields: [
          { name: "label", type: "string", label: draft.xLabel.trim() },
          { name: "value", type: "number", label: draft.valueLabel.trim() },
        ],
        rows: rows.map((r) => ({ label: r.label.trim(), value: Number(r.value) })),
      },
    },
  };
}

/** The example rows a rule's editor opens on: the stored ones, else one blank row. */
export const tableRowsOf = (picture: RequirementPictureView | null): ExampleTableContent["rows"] =>
  picture?.kind === "example_table" ? (picture.content as ExampleTableContent).rows.map((r) => ({ ...r })) : [{ input: "", expected: "" }];

/** Where a refusal's path lands in the editor: the field it names, else the editor as a whole. */
export type PictureField = "kind" | "alt" | "steps" | "links" | "xLabel" | "valueLabel" | "board" | `row:${number}` | "content";

export function fieldOfPath(path: string, picture: PictureKind): PictureField | null {
  if (path === "/kind") return "kind";
  if (path === "/alt") return "alt";
  const row = /^\/content\/rows\/(\d+)/.exec(path);
  if (row && picture === "example_table") return `row:${Number(row[1])}`;
  if (path.startsWith("/content/nodes")) return "steps";
  if (path.startsWith("/content/edges")) return "links";
  if (path.startsWith("/content/board")) return "board";
  if (path.startsWith("/content")) return "content";
  return null;
}
