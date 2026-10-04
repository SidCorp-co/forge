import type { TemplateEdgeKind, WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { type Canvas, edgeText, purposeOf, readCanvas, titleOf } from "../canvas/model";
import type { WorkflowBody, WorkflowLane } from "../types";

export const SYSTEM_CONTEXT_TEMPLATE = "system-context";

/**
 * What an element is on a C4 diagram: a person; the in-scope system's own `system` or `container`
 * (inside its boundary); or an `external` element, anything else that is not a person.
 */
export type NodeKind = "person" | "system" | "container" | "external";

/** Whether a design states an outside system's integration as settled (`integrationOf`). */
export type IntegrationState = "confirmed" | "unconfirmed";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** The design's label; `name` drops an unconfirmed aside from an external's. */
  title: string;
  name: string;
  purpose: string;
  owner: string | null;
  boundary: string | null;
  integration: IntegrationState | null;
  /** The words the integration state was read from, for its badge's tooltip. */
  mark: string | null;
}

/** One relationship the design draws, with its own words and what it runs over. */
export interface Relationship {
  id: string;
  from: string;
  to: string;
  label: string;
  technology: string | null;
  kind: TemplateEdgeKind;
}

export type BoundarySide = "people" | "focal" | "outside";

/** A design lane, split by side: the people in it, the in-scope system's parts, or outside elements. */
export interface Boundary {
  id: string;
  lane: string;
  side: BoundarySide;
  label: string;
  tip: string;
  members: string[];
}

/** The software system the design is about. */
export interface FocalSystem {
  boundary: string | null;
  title: string;
  tip: string;
  /** What the system is, in the design's own words: the in-scope system's stated `purpose`, else empty. */
  purpose: string;
  parts: string[];
}

export interface FactRow {
  name: string;
  count?: number;
  unconfirmed?: number;
}

/** What the overview's header states, counted once here. */
export interface GraphFacts {
  people: FactRow[];
  externals: number;
  /** Outside elements by boundary, in lane order, those in no boundary last. */
  boundaries: FactRow[];
  namedBoundaries: number;
}

export interface SystemGraph {
  canvas: Canvas;
  focal: FocalSystem | null;
  nodes: GraphNode[];
  node: ReadonlyMap<string, GraphNode>;
  relationships: Relationship[];
  boundaries: Boundary[];
  facts: GraphFacts;
}

type Doc = Pick<WorkflowBody, "title" | "summary" | "kind" | "steps" | "edges" | "flow" | "lanes">;

type C4Type = "person" | "system" | "container";

const c4TypeOf = (type: string): C4Type => (type === "PERSON" ? "person" : type === "CONTAINER" ? "container" : "system");

// The schema has no field for whether an outside system's integration is settled, so designs say it in
// a closing aside on the label, in the project's own language. Only an aside naming it unconfirmed or
// proposed counts.
const OPEN_MARK = /\s*\(([^()]*?(?:chưa xác nhận|đề xuất|unconfirmed|not confirmed|proposed|to be confirmed)[^()]*)\)\s*$/iu; // i18n-allow: the words HOP's designs mark an open integration with

export function integrationOf(title: string): { name: string; state: IntegrationState; mark: string | null } {
  const m = OPEN_MARK.exec(title);
  if (!m) return { name: title.trim(), state: "confirmed", mark: null };
  return { name: title.slice(0, m.index).trim() || title.trim(), state: "unconfirmed", mark: m[1]?.trim() ?? null };
}

interface Element {
  id: string;
  type: C4Type;
  title: string;
  lane: string | null;
}

/**
 * The system in scope is the boundary that holds the containers (C4: containers only ever live inside
 * the system being described). A design with no container has no boundary to read, so its most
 * connected system stands alone as the one in scope.
 */
function focalOf(els: Element[], lanes: readonly WorkflowLane[], c: Canvas): FocalSystem | null {
  const stated = (id: string | undefined) => (id ? (c.steps.get(id)?.node?.purpose?.trim() ?? "") : "");
  const does = (id: string | undefined) => {
    const s = id ? c.steps.get(id) : undefined;
    return s ? purposeOf(s) : "";
  };
  const containers = els.filter((e) => e.type === "container");
  if (containers.length > 0) {
    const count = new Map<string | null, number>();
    for (const e of containers) count.set(e.lane, (count.get(e.lane) ?? 0) + 1);
    const lane = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const parts = els.filter((e) => e.type !== "person" && (e.lane === lane || (e.type === "container" && e.lane === null)));
    const named = lanes.find((l) => l.id === lane);
    const system = parts.find((p) => p.type === "system");
    return {
      boundary: lane,
      title: named?.label ?? system?.title ?? "This system",
      tip: named?.tooltip ?? does(system?.id),
      purpose: stated(system?.id),
      parts: parts.map((p) => p.id),
    };
  }
  const systems = els.filter((e) => e.type === "system");
  const degree = (id: string) => c.edges.filter((e) => e.from === id || e.to === id).length;
  const top = [...systems].sort((a, b) => degree(b.id) - degree(a.id))[0];
  if (!top) return null;
  return { boundary: top.lane, title: top.title, tip: does(top.id), purpose: stated(top.id), parts: [top.id] };
}

function factsOf(nodes: GraphNode[], boundaries: Boundary[], node: ReadonlyMap<string, GraphNode>): GraphFacts {
  const externals = nodes.filter((n) => n.kind === "external");
  const unconfirmed = (ids: string[]) => ids.filter((id) => node.get(id)?.integration === "unconfirmed").length;
  const outside = boundaries.filter((b) => b.side === "outside");
  const loose = externals.filter((n) => n.boundary === null).map((n) => n.id);
  return {
    people: nodes.filter((n) => n.kind === "person").map((n) => ({ name: n.title })),
    externals: externals.length,
    boundaries: [
      ...outside.map((b) => ({ name: b.label, count: b.members.length, unconfirmed: unconfirmed(b.members) })),
      ...(loose.length ? [{ name: "No boundary", count: loose.length, unconfirmed: unconfirmed(loose) }] : []),
    ],
    namedBoundaries: outside.length,
  };
}

/** A system-context design read as a C4 graph: its elements, its relationships and its boundaries. */
export function readSystemGraph(doc: Doc, template: WorkflowTemplate | null): SystemGraph {
  const canvas = readCanvas(doc, template);
  const lanes = doc.lanes ?? [];
  const els: Element[] = doc.steps.map((s) => ({ id: s.id, type: c4TypeOf(canvas.typeOf(s.id).id), title: titleOf(s), lane: s.node?.band ?? null }));
  const focal = focalOf(els, lanes, canvas);
  const inside = new Set(focal?.parts ?? []);
  const nodes: GraphNode[] = els.map((e) => {
    const step = canvas.steps.get(e.id);
    const kind: NodeKind = e.type === "person" ? "person" : inside.has(e.id) ? e.type : "external";
    const said = kind === "external" ? integrationOf(e.title) : null;
    return {
      id: e.id,
      kind,
      title: e.title,
      name: said?.name ?? e.title,
      purpose: step ? purposeOf(step) : "",
      owner: step?.node?.owner ?? null,
      boundary: e.lane,
      integration: said?.state ?? null,
      mark: said?.mark ?? null,
    };
  });
  const node = new Map(nodes.map((n) => [n.id, n]));
  const sideOf = (n: GraphNode): BoundarySide => (n.kind === "person" ? "people" : n.kind === "external" ? "outside" : "focal");
  const boundaries: Boundary[] = [];
  for (const lane of lanes) {
    for (const side of ["people", "focal", "outside"] as const) {
      const members = nodes.filter((n) => n.boundary === lane.id && sideOf(n) === side).map((n) => n.id);
      if (members.length) boundaries.push({ id: `${side}:${lane.id}`, lane: lane.id, side, label: lane.label, tip: lane.tooltip ?? "", members });
    }
  }
  const relationships: Relationship[] = canvas.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    label: edgeText(e) || e.kind.label,
    technology: e.contract?.protocol ?? null,
    kind: e.kind,
  }));
  return { canvas, focal, nodes, node, relationships, boundaries, facts: factsOf(nodes, boundaries, node) };
}

/** A relationship in one line, for a tooltip: its ends, its words and what it runs over. */
export function relationshipText(r: Relationship, g: SystemGraph): string {
  const name = (id: string) => g.node.get(id)?.name ?? id;
  return `${name(r.from)} → ${name(r.to)}: ${r.label}${r.technology ? ` [${r.technology}]` : ""}`;
}
