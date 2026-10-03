import type { ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api";
import { type CanvasEdge, titleOf } from "../canvas/model";
import { elk } from "../canvas/layout";
import { type DBox, type Diagram, type DLine, LABEL_SIZE, lineStyle, PathBuilder, type Pt, textWidth, TITLE_SIZE, wrap } from "./geometry";
import { type C4Element, type C4Model, shortLabel } from "./model";

const BOX_W = 196;
const BOX_H = 62;
const PAD = 16;
const BRACKET = 14;
const BOUNDARY = "__boundary";

const KICKER: Record<C4Element["kind"], [inside: string, outside: string]> = {
  person: ["Person", "Person"],
  system: ["System", "External system"],
  container: ["Container", "Container"],
};

/** Where a line's words go: the middle of its longest level run, if the words fit along it; otherwise nowhere on the canvas. */
function labelSpot(points: readonly Pt[], text: string): Pt | null {
  const need = textWidth(text, LABEL_SIZE) + 14;
  let best: { at: Pt; len: number } | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Pt;
    const b = points[i] as Pt;
    if (Math.abs(a.y - b.y) > 0.5) continue;
    const len = Math.abs(b.x - a.x);
    if (len >= need && (!best || len > best.len)) best = { at: { x: (a.x + b.x) / 2, y: a.y - 8 }, len };
  }
  return best?.at ?? null;
}

/**
 * C4 level 2: the system's parts inside its boundary, people to its left and outside systems to its
 * right (ELK partitions 0 | 1 | 2), the lines between them routed orthogonally around the boxes. A line
 * between two people, or two outside systems, is a bracket on its column's outer side, as on Context, so
 * it does not push a column into two. ELK's layered algorithm is deterministic: the same design always
 * draws the same picture.
 */
export async function layoutContainers(m: C4Model): Promise<Diagram | null> {
  const focal = m.focal;
  if (!focal) return null;
  const inside = new Set(focal.parts.map((p) => p.id));
  const people = new Set(m.people.map((p) => p.id));
  const outside = new Set(m.externals.map((x) => x.id));
  const sideOf = (e: CanvasEdge): "l" | "r" | null =>
    people.has(e.from) && people.has(e.to) ? "l" : outside.has(e.from) && outside.has(e.to) ? "r" : null;
  const routed = m.canvas.edges.filter((e) => sideOf(e) === null);
  const brackets = m.canvas.edges.filter((e) => sideOf(e) !== null);
  const node = (el: C4Element, partition: number | null): ElkNode => ({
    id: el.id,
    width: BOX_W,
    height: BOX_H,
    ...(partition === null ? {} : { layoutOptions: { "elk.partitioning.partition": String(partition) } }),
  });
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.partitioning.activate": "true",
      "elk.spacing.nodeNode": "28",
      // Room between layers for a line's words along its level run.
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.spacing.edgeNode": "18",
      "elk.spacing.edgeEdge": "12",
      "elk.layered.spacing.edgeNodeBetweenLayers": "14",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    },
    children: [
      ...m.people.map((p) => node(p, 0)),
      {
        id: BOUNDARY,
        layoutOptions: { "elk.partitioning.partition": "1", "elk.padding": "[top=46,left=20,bottom=20,right=20]" },
        children: focal.parts.map((p) => node(p, null)),
      },
      ...m.externals.map((x) => node(x, 2)),
    ],
    edges: routed.map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const out = await (await elk()).layout(graph);

  const words = new Map(m.canvas.edges.map((e) => [e.id, shortLabel(e.contract?.label ?? e.contract?.condition ?? "", 26)]));
  const levelOf = new Map<string, number>();
  let depth = { l: 0, r: 0 };
  {
    const yOf = new Map((out.children ?? []).map((c) => [c.id, (c.y ?? 0) + (c.height ?? 0) / 2]));
    for (const side of ["l", "r"] as const) {
      const levels: [number, number][][] = [];
      const span = (e: CanvasEdge) => [yOf.get(e.from) ?? 0, yOf.get(e.to) ?? 0].sort((a, b) => a - b) as [number, number];
      for (const e of brackets.filter((b) => sideOf(b) === side).sort((a, b) => span(a)[1] - span(a)[0] - (span(b)[1] - span(b)[0]))) {
        const [a, b] = span(e);
        let k = 0;
        while (levels[k]?.some(([c, d]) => a <= d + 4 && c <= b + 4)) k++;
        levels[k] = [...(levels[k] ?? []), [a, b]];
        levelOf.set(e.id, k);
      }
      depth = { ...depth, [side]: levels.length };
    }
  }
  const room = (side: "l" | "r") => {
    const own = brackets.filter((b) => sideOf(b) === side);
    if (own.length === 0) return 0;
    return 16 + BRACKET * depth[side] + Math.max(...own.map((e) => textWidth(words.get(e.id) ?? "", LABEL_SIZE))) + 8;
  };
  const left = PAD + room("l");

  const origin = new Map<string, ElkPoint>([["root", { x: left, y: PAD }]]);
  const abs = new Map<string, { x: number; y: number; w: number; h: number }>();
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      abs.set(c.id, { x, y, w: c.width ?? BOX_W, h: c.height ?? BOX_H });
      origin.set(c.id, { x, y });
      walk(c, x, y);
    }
  };
  walk(out, left, PAD);

  const byId = new Map([...m.people, ...m.externals, ...focal.parts].map((e) => [e.id, e]));
  const boxes: DBox[] = [];
  for (const [id, b] of abs) {
    const el = byId.get(id);
    if (!el) continue;
    boxes.push({
      id,
      ...b,
      kind: el.kind,
      kicker: KICKER[el.kind][inside.has(id) ? 0 : 1],
      lines: wrap(el.title, BOX_W - 24, TITLE_SIZE),
      tip: [el.title, el.owner ? `Owner: ${el.owner}` : null, el.purpose].filter(Boolean).join("\n"),
      step: id,
    });
  }

  const name = (id: string) => {
    const s = m.canvas.steps.get(id);
    return s ? titleOf(s) : id;
  };
  const tip = (e: CanvasEdge) =>
    `${name(e.from)} → ${name(e.to)}: ${e.contract?.label ?? e.contract?.condition ?? e.kind.label}${e.contract?.protocol ? ` [${e.contract.protocol}]` : ""}`;
  const line = (e: CanvasEdge, pb: PathBuilder, label: string, at: Pt, anchor: DLine["anchor"]): DLine => ({
    id: e.id,
    d: pb.path,
    samples: pb.samples,
    label,
    tip: tip(e),
    at,
    anchor,
    ...lineStyle({ src: [e] }),
    arrowStart: false,
    arrowEnd: true,
    edge: e.id,
    ends: [e.from, e.to],
  });

  const elkEdges: ElkExtendedEdge[] = [];
  const collect = (n: ElkNode) => {
    elkEdges.push(...(n.edges ?? []));
    for (const c of n.children ?? []) collect(c);
  };
  collect(out);
  const lines: DLine[] = [];
  for (const ee of elkEdges) {
    const e = routed.find((c) => c.id === ee.id);
    const s = ee.sections?.[0];
    if (!e || !s) continue;
    const o = origin.get((ee as { container?: string }).container ?? "root") ?? { x: left, y: PAD };
    const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
    const pb = new PathBuilder().move(pts[0] as Pt).corners(pts.slice(1));
    const text = words.get(e.id) ?? "";
    const spot = text ? labelSpot(pts, text) : null;
    lines.push(line(e, pb, spot ? text : "", spot ?? (pts[0] as Pt), "middle"));
  }

  // Brackets: out of the column's outer side, along it at the bracket's level, back in.
  const portCount = new Map<string, number>();
  const nextPort = (id: string) => {
    const n = portCount.get(id) ?? 0;
    portCount.set(id, n + 1);
    return n;
  };
  for (const e of brackets) {
    const side = sideOf(e) as "l" | "r";
    const a = abs.get(e.from);
    const b = abs.get(e.to);
    if (!a || !b) continue;
    const k = levelOf.get(e.id) ?? 0;
    const edgeX = side === "l" ? Math.min(a.x, b.x) : Math.max(a.x + a.w, b.x + b.w);
    const bx = side === "l" ? edgeX - 16 - BRACKET * k : edgeX + 16 + BRACKET * k;
    const ax = side === "l" ? a.x : a.x + a.w;
    const qx = side === "l" ? b.x : b.x + b.w;
    const p = { x: ax, y: a.y + a.h / 2 - 8 + 8 * nextPort(e.from) };
    const q = { x: qx, y: b.y + b.h / 2 + 8 - 8 * nextPort(e.to) };
    const pb = new PathBuilder().move(p).corners([{ x: bx, y: p.y }, { x: bx, y: q.y }, q]);
    lines.push(line(e, pb, words.get(e.id) ?? "", { x: side === "l" ? bx - 6 : bx + 6, y: (p.y + q.y) / 2 }, side === "l" ? "end" : "start"));
  }

  const b = abs.get(BOUNDARY);
  return {
    level: "containers",
    width: left + (out.width ?? 0) + room("r") + PAD,
    height: (out.height ?? 0) + 2 * PAD,
    boxes,
    lines,
    captions: [],
    boundary: b ? { ...b, title: focal.title, tip: focal.tip } : null,
  };
}
