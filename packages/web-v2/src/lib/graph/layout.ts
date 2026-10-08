import type { ELK, ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api";

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
export function elk(): Promise<ELK> {
  engine ??= import("elkjs/lib/elk.bundled.js").then((m) => new m.default());
  return engine;
}

/** A label's box before it is drawn: wide enough for its words, wrapped at 200px. */
export function labelBox(text: string): Size {
  const width = Math.min(200, 16 + text.length * 6.4);
  const lines = Math.max(1, Math.ceil((text.length * 6.4) / 184));
  return { width, height: 8 + lines * 15 };
}

export interface GraphNode extends Size {
  id: string;
  /** The node's band row, top to bottom, when the graph is banded. */
  partition?: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  labelPlacement?: "CENTER" | "TAIL";
}

/** ELK's own padding round each disconnected piece, which a row of pieces is measured with. */
const PIECE_PAD = 12;

/**
 * Any boxes-and-lines graph laid out by ELK's layered algorithm. With `rowWidth`, the pieces that no
 * line joins are packed into rows no wider than it, in the order given, instead of one long layer.
 */
export async function layoutGraph(input: {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  direction: "down" | "right";
  partitioned: boolean;
  rowWidth?: number;
}): Promise<Placed> {
  const { nodes, edges, direction, partitioned, rowWidth } = input;
  const area = nodes.reduce((sum, n) => sum + (n.width + 2 * PIECE_PAD) * (n.height + 2 * PIECE_PAD), 0);
  const rows: Record<string, string> = rowWidth
    ? {
        "elk.padding": `[top=${PIECE_PAD},left=${PIECE_PAD},bottom=${PIECE_PAD},right=${PIECE_PAD}]`,
        "elk.aspectRatio": String(rowWidth / Math.sqrt(area || 1)),
        "elk.layered.considerModelOrder.components": "MODEL_ORDER",
      }
    : {};
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction === "down" ? "DOWN" : "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.partitioning.activate": partitioned ? "true" : "false",
      "elk.layered.spacing.nodeNodeBetweenLayers": "28",
      "elk.spacing.nodeNode": "44",
      "elk.spacing.edgeNode": "22",
      "elk.spacing.edgeEdge": "14",
      "elk.spacing.edgeLabel": "6",
      "elk.layered.spacing.edgeNodeBetweenLayers": "12",
      // SIMPLE centres each layer on one axis. NETWORK_SIMPLEX shortened the long Trigger lines by pushing
      // that band ~450px right of the rest, so the first card opened clipped (hop-layout.test.ts).
      "elk.layered.nodePlacement.strategy": "SIMPLE",
      "elk.layered.mergeEdges": "false",
      ...rows,
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: n.width,
      height: n.height,
      ...(partitioned && n.partition !== undefined ? { layoutOptions: { "elk.partitioning.partition": String(n.partition) } } : {}),
    })),
    edges: edges.map(
      (e): ElkExtendedEdge => ({
        id: e.id,
        sources: [e.from],
        targets: [e.to],
        labels: e.label
          ? [{ text: e.label, ...labelBox(e.label), layoutOptions: { "elk.edgeLabels.placement": e.labelPlacement ?? "CENTER" } }]
          : [],
      }),
    ),
  };
  const out = await (await elk()).layout(graph);
  const placedNodes = new Map(
    (out.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 }]),
  );
  const placedEdges = new Map(
    (out.edges ?? []).map((e) => {
      const s = e.sections?.[0];
      const points = s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] : [];
      const l = e.labels?.[0];
      return [e.id, { points, label: l ? { x: (l.x ?? 0) + (l.width ?? 0) / 2, y: (l.y ?? 0) + (l.height ?? 0) / 2 } : null }];
    }),
  );
  return { nodes: placedNodes, edges: placedEdges, width: out.width ?? 0, height: out.height ?? 0 };
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
