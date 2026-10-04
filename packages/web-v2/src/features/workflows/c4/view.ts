import type { Boundary, GraphNode, NodeKind, Relationship, SystemGraph } from "./graph";

/** C4 level 1 draws the system as one box; level 2 opens it into its boundary of parts. */
export type Level = "context" | "containers";

/** `boundaries` folds each boundary of two or more outside elements into one box; `systems` draws every one. */
export type Detail = "boundaries" | "systems";

/** People fold by boundary only past this many, so a few roles stay readable one by one. */
export const PEOPLE_AT_A_GLANCE = 4;

export const FOCAL = "__system";

/** Left to right: people, the system, everything outside it. */
export type Column = 0 | 1 | 2;

export interface ViewNode {
  id: string;
  kind: NodeKind | "focal" | "group";
  column: Column;
  name: string;
  tip: string;
  /** The design steps the box stands for, for selection, search and the walk-through. */
  steps: string[];
  /** The frame the box sits in. */
  frame: string | null;
  /** A folded boundary's members, or the focal system's part count. */
  members: GraphNode[];
  count: number | null;
  node: GraphNode | null;
}

/** An opened boundary drawn round its members. */
export interface ViewFrame {
  id: string;
  column: Column;
  label: string;
  tip: string;
  /** The viewer opened it from its folded box, so it can fold back. */
  folds: boolean;
}

/** One drawn line: every relationship between the two boxes it joins, in design order. */
export interface ViewEdge {
  id: string;
  from: string;
  to: string;
  rels: Relationship[];
  /** Some relationship runs `to` → `from`. */
  back: boolean;
  /** Some relationship runs `from` → `to`. */
  forward: boolean;
}

export interface SystemView {
  level: Level;
  nodes: ViewNode[];
  frames: ViewFrame[];
  edges: ViewEdge[];
}

const COLUMN: Record<NodeKind, Column> = { person: 0, system: 1, container: 1, external: 2 };

const leaf = (n: GraphNode, frame: string | null): ViewNode => ({
  id: n.id,
  kind: n.kind,
  column: COLUMN[n.kind],
  name: n.name,
  tip: [n.title, n.owner ? `Owner: ${n.owner}` : null, n.purpose].filter(Boolean).join("\n"),
  steps: [n.id],
  frame,
  members: [],
  count: null,
  node: n,
});

/** Whether the Boundaries view folds this boundary, before the viewer opens any. */
export function folds(b: Boundary, g: SystemGraph): boolean {
  if (b.members.length < 2) return false;
  if (b.side === "outside") return true;
  return b.side === "people" && g.nodes.filter((n) => n.kind === "person").length > PEOPLE_AT_A_GLANCE;
}

/**
 * The graph as one C4 view. `level` folds or opens the system in scope; `detail` folds or opens every
 * other boundary, except those in `open`. A relationship is lifted to the boxes that now stand for its
 * ends and merged once per pair; one inside a single box is not drawn.
 */
export function viewOf(g: SystemGraph, level: Level, detail: Detail, open: ReadonlySet<string> = new Set()): SystemView | null {
  const focal = g.focal;
  if (!focal) return null;
  const nodes: ViewNode[] = [];
  const frames: ViewFrame[] = [];
  const box = new Map<string, string>();
  const parts = focal.parts.map((id) => g.node.get(id)).filter((n): n is GraphNode => Boolean(n));

  if (level === "context") {
    nodes.push({ id: FOCAL, kind: "focal", column: 1, name: focal.title, tip: [focal.title, focal.tip].filter(Boolean).join("\n"), steps: focal.parts, frame: null, members: parts, count: parts.length, node: null });
    for (const p of parts) box.set(p.id, FOCAL);
  } else {
    frames.push({ id: FOCAL, column: 1, label: focal.title, tip: focal.tip, folds: false });
    for (const p of parts) {
      nodes.push(leaf(p, FOCAL));
      box.set(p.id, p.id);
    }
  }

  const byBoundary = new Map(g.boundaries.flatMap((b) => b.members.map((id) => [id, b] as const)));
  const placed = new Set<string>();
  for (const n of g.nodes) {
    if (n.kind !== "person" && n.kind !== "external") continue;
    const b = byBoundary.get(n.id);
    if (!b || b.members.length < 2) {
      nodes.push(leaf(n, null));
      box.set(n.id, n.id);
      continue;
    }
    if (placed.has(b.id)) continue;
    placed.add(b.id);
    const members = b.members.map((id) => g.node.get(id)).filter((m): m is GraphNode => Boolean(m));
    const column = COLUMN[n.kind];
    if (detail === "boundaries" && folds(b, g) && !open.has(b.id)) {
      nodes.push({ id: b.id, kind: "group", column, name: b.label, tip: [b.label, b.tip].filter(Boolean).join("\n"), steps: b.members, frame: null, members, count: members.length, node: null });
      for (const id of b.members) box.set(id, b.id);
      continue;
    }
    // People are never framed: their boxes already say what they are.
    const frame = n.kind === "external" ? b.id : null;
    if (frame) frames.push({ id: b.id, column, label: b.label, tip: b.tip, folds: detail === "boundaries" && open.has(b.id) });
    for (const m of members) {
      nodes.push(leaf(m, frame));
      box.set(m.id, m.id);
    }
  }

  const edges: ViewEdge[] = [];
  const byPair = new Map<string, ViewEdge>();
  for (const r of g.relationships) {
    const from = box.get(r.from);
    const to = box.get(r.to);
    if (!from || !to || from === to) continue;
    const key = [from, to].sort().join("|");
    const seen = byPair.get(key);
    if (seen) {
      seen.rels.push(r);
      if (seen.from === from) seen.forward = true;
      else seen.back = true;
      continue;
    }
    const e: ViewEdge = { id: `rel:${key}`, from, to, rels: [r], back: false, forward: true };
    byPair.set(key, e);
    edges.push(e);
  }
  return { level, nodes, frames, edges };
}

/** Whether a Boundaries view of this graph folds anything, so the toggle has something to do. */
export const foldable = (g: SystemGraph) => g.boundaries.some((b) => folds(b, g));
