import type { ELK, ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api";
import type { View } from "./view";

export interface Size {
  width: number;
  height: number;
}

export interface Placed {
  nodes: Map<string, { x: number; y: number; width: number; height: number }>;
  edges: Map<string, { points: ElkPoint[]; label: ElkPoint | null }>;
  width: number;
  height: number;
}

let engine: Promise<ELK> | null = null;

/** elkjs loads on first layout, off the page's first paint, and lays out asynchronously from then on. */
function elk(): Promise<ELK> {
  engine ??= import("elkjs/lib/elk.bundled.js").then((m) => new m.default());
  return engine;
}

/** A label's box before it is drawn: wide enough for its words, wrapped at 200px. */
export function labelBox(text: string): Size {
  const width = Math.min(200, 16 + text.length * 6.4);
  const lines = Math.max(1, Math.ceil((text.length * 6.4) / 184));
  return { width, height: 8 + lines * 15 };
}

export async function layoutView(input: {
  view: View;
  sizes: ReadonlyMap<string, Size>;
  labels: ReadonlyMap<string, string>;
  /** Each node's band row, top to bottom; absent, the graph is not banded. */
  partition: ((key: string) => number) | null;
  direction: "down" | "right";
}): Promise<Placed> {
  const { view, sizes, labels, partition, direction } = input;
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction === "down" ? "DOWN" : "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.partitioning.activate": partition ? "true" : "false",
      "elk.layered.spacing.nodeNodeBetweenLayers": "28",
      "elk.spacing.nodeNode": "44",
      "elk.spacing.edgeNode": "22",
      "elk.spacing.edgeEdge": "14",
      "elk.spacing.edgeLabel": "6",
      "elk.layered.spacing.edgeNodeBetweenLayers": "12",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.mergeEdges": "false",
    },
    children: view.nodes.map((n) => ({
      id: n.key,
      width: sizes.get(n.key)?.width ?? 250,
      height: sizes.get(n.key)?.height ?? 60,
      ...(partition ? { layoutOptions: { "elk.partitioning.partition": String(partition(n.key)) } } : {}),
    })),
    edges: view.edges
      .filter((e) => e.src.every((s) => s.kind.direction === "forward"))
      .map((e): ElkExtendedEdge => {
        const text = labels.get(e.key);
        return {
          id: e.key,
          sources: [e.from],
          targets: [e.to],
          labels: text
            ? [{ text, ...labelBox(text), layoutOptions: { "elk.edgeLabels.placement": "CENTER" } }]
            : [],
        };
      }),
  };
  const out = await (await elk()).layout(graph);
  const nodes = new Map(
    (out.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 }]),
  );
  const edges = new Map(
    (out.edges ?? []).map((e) => {
      const s = e.sections?.[0];
      const points = s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] : [];
      const l = e.labels?.[0];
      return [e.id, { points, label: l ? { x: (l.x ?? 0) + (l.width ?? 0) / 2, y: (l.y ?? 0) + (l.height ?? 0) / 2 } : null }];
    }),
  );
  return { nodes, edges, width: out.width ?? 0, height: out.height ?? 0 };
}

/** A polyline with its corners rounded, as an SVG path. */
export function rounded(points: readonly ElkPoint[], radius = 10): string {
  const [first, ...rest] = points;
  if (!first) return "";
  let d = `M${first.x},${first.y}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const p = points[i] as ElkPoint;
    const c = rest[i] as ElkPoint;
    const n = rest[i + 1] as ElkPoint;
    const d1 = Math.hypot(c.x - p.x, c.y - p.y);
    const d2 = Math.hypot(n.x - c.x, n.y - c.y);
    if (!d1 || !d2) continue;
    const r = Math.min(radius, d1 / 2, d2 / 2);
    const a = { x: c.x + ((p.x - c.x) * r) / d1, y: c.y + ((p.y - c.y) * r) / d1 };
    const b = { x: c.x + ((n.x - c.x) * r) / d2, y: c.y + ((n.y - c.y) * r) / d2 };
    d += ` L${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`;
  }
  const last = rest[rest.length - 1];
  return last ? `${d} L${last.x},${last.y}` : d;
}

/** A return line: out of the later card's right side, along the right of the whole graph, into the earlier card. */
export function returnPath(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
  rightEdge: number,
): { d: string; label: ElkPoint } {
  const sx = from.x + from.width;
  const sy = from.y + from.height / 2;
  const ex = to.x + to.width + 6;
  const ey = to.y + to.height / 2;
  const x = rightEdge;
  const up = sy > ey;
  const bend = Math.min(60, Math.abs(sy - ey) / 2);
  const d = up
    ? `M${sx},${sy} C${x + 10},${sy} ${x},${sy - bend * 0.4} ${x},${sy - bend} L${x},${ey + bend} C${x},${ey + bend * 0.4} ${x + 10},${ey} ${ex},${ey}`
    : `M${sx},${sy} C${x + 10},${sy} ${x},${sy + bend * 0.4} ${x},${sy + bend} L${x},${ey - bend} C${x},${ey - bend * 0.4} ${x + 10},${ey} ${ex},${ey}`;
  return { d, label: { x, y: (sy + ey) / 2 } };
}
