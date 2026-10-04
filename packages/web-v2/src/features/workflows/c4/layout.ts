import type { TemplateEdgeKind } from "@forge/contracts/workflow-templates";
import type { ElkExtendedEdge, ElkLabel, ElkNode, ElkPoint } from "elkjs/lib/elk-api";
import { elk, rounded } from "../canvas/layout";
import { DASH, edgeHue } from "../canvas/style";
import type { Relationship } from "../types";
import type { SystemView, ViewEdge, ViewFrame, ViewNode } from "./view";

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Every type size a C4 diagram draws, in diagram units (one CSS pixel at 100% zoom). The renderer reads
 * them from here, so the smallest is the floor `MIN_FONT_PX` is held against.
 */
export const FONT = { title: 13.5, focal: 15, label: 12, chip: 12, frame: 13 } as const;

/** No text is drawn smaller than this on screen at fit; a diagram that cannot fit folds instead. */
export const MIN_FONT_PX = 12;
export const MIN_READABLE_ZOOM = MIN_FONT_PX / Math.min(...Object.values(FONT));

export const BOX = { w: 156, h: 60 } as const;
export const FOCAL_BOX = { w: 168, h: 88 } as const;
const LABEL_MAX = 36;
/** A line label wraps inside this width, onto at most two lines of words. */
const LABEL_W = 128;
const LABEL_LINE = 15;
const FRAME_PAD = { top: 34, side: 16 } as const;

/** A string's drawn width in the UI face, estimated: Vietnamese with its diacritics runs close to 0.56em. */
export const textWidth = (s: string, size: number) => s.length * size * 0.56;

/** A line's words on a diagram: the clause before its first aside, cut at a word inside `max` characters. */
export function shortLabel(text: string, max = LABEL_MAX): string {
  const t = text.trim();
  const clause = t.split(/\s*[(,;:–—]\s*/)[0]?.trim() ?? t;
  const base = clause.length >= 6 ? clause : t;
  if (base.length <= max) return base;
  const cut = base.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Words wrapped into at most `lines` lines inside `width`, the last one cut with an ellipsis. */
export function wrap(text: string, width: number, size: number, lines = 2): string[] {
  const words = text.trim().split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (textWidth(next, size) <= width || !line) {
      line = next;
      continue;
    }
    out.push(line);
    line = w;
    if (out.length === lines) break;
  }
  if (out.length < lines && line) out.push(line);
  const used = out.join(" ").split(/\s+/).length;
  if (used < words.length || textWidth(out[out.length - 1] ?? "", size) > width) {
    let last = out[out.length - 1] ?? "";
    while (last.length > 1 && textWidth(`${last}…`, size) > width) last = last.slice(0, -1);
    out[out.length - 1] = `${last.trimEnd()}…`;
  }
  return out;
}

export interface DBox extends Rect {
  node: ViewNode;
  lines: string[];
}

export interface DFrame extends Rect {
  frame: ViewFrame;
}

/** A merged line's words: the first relationship's own label, and how many more it stands for. */
export interface DLabel extends Rect {
  text: string;
  more: number;
  /** The words as wrapped, and whether the "+N more" chip takes a line of its own after them. */
  lines: string[];
  chipBelow: boolean;
}

export interface DLine {
  id: string;
  edge: ViewEdge;
  d: string;
  /** The routed polyline, for hit tests and the layout checks. */
  points: Pt[];
  label: DLabel | null;
  /** The drawn path runs `ends[0]` → `ends[1]`; the arrowheads say which way the relationships go. */
  ends: [string, string];
  arrowStart: boolean;
  arrowEnd: boolean;
  dash: string | undefined;
  colour: string;
}

export interface Diagram {
  width: number;
  height: number;
  boxes: DBox[];
  frames: DFrame[];
  lines: DLine[];
}

/** One kind's dash and colour, or a plain line when it merges relationships of different kinds. */
export function lineStyle(rels: readonly Relationship[]): { dash: string | undefined; colour: string } {
  const kinds = new Map<string, TemplateEdgeKind>(rels.map((r) => [r.kind.id, r.kind]));
  const only = kinds.size === 1 ? [...kinds.values()][0] : undefined;
  return only ? { dash: DASH[only.line], colour: edgeHue(only) } : { dash: undefined, colour: "var(--wf-edge)" };
}

type LabelWords = Omit<DLabel, keyof Rect>;

export function labelOf(e: ViewEdge): LabelWords {
  const text = shortLabel(e.rels[0]?.label ?? "");
  const more = e.rels.length - 1;
  const lines = text ? wrap(text, LABEL_W - 12, FONT.label) : [];
  const last = textWidth(lines[lines.length - 1] ?? "", FONT.label);
  const chipBelow = more > 0 && last + chipWidth(more) > LABEL_W - 12;
  return { text, more, lines, chipBelow };
}

const chipWidth = (more: number) => textWidth(`+${more} more`, FONT.chip) + 14;

const sizeOf = (n: ViewNode) => (n.kind === "focal" ? FOCAL_BOX : BOX);

const linesOf = (n: ViewNode) => wrap(n.name, sizeOf(n).w - (n.count === null ? 24 : 56), n.kind === "focal" ? FONT.focal : FONT.title, n.kind === "focal" ? 3 : 2);

function labelBox(e: ViewEdge): ElkLabel | null {
  const { text, more, lines, chipBelow } = labelOf(e);
  if (!text) return null;
  const rows = lines.map((l, i) => textWidth(l, FONT.label) + (more && !chipBelow && i === lines.length - 1 ? chipWidth(more) : 0));
  if (chipBelow) rows.push(chipWidth(more));
  return { id: `${e.id}:label`, text, width: Math.min(LABEL_W, Math.max(...rows) + 12), height: rows.length * LABEL_LINE + 4 };
}

/**
 * With no outside boundary open, the outside boxes stack in one column when every line between two of
 * them can join neighbours there: the order puts each chain of such lines next to each other. ELK's
 * layered algorithm routes no line between two boxes of one layer, so those lines are left out of its
 * graph and drawn straight down the column (`columnLine`). A cycle, or a box with lines to three
 * others in the column, keeps the outside boxes in layers of their own.
 */
function stackOf(v: SystemView): { order: string[]; lines: ViewEdge[] } | null {
  if (v.frames.some((f) => f.column === 2)) return null;
  const col = v.nodes.filter((n) => n.column === 2 && n.frame === null).map((n) => n.id);
  const inCol = new Set(col);
  const lines = v.edges.filter((e) => inCol.has(e.from) && inCol.has(e.to));
  if (lines.length === 0) return null;
  const next = new Map<string, string[]>(col.map((id) => [id, []]));
  for (const e of lines) {
    next.get(e.from)?.push(e.to);
    next.get(e.to)?.push(e.from);
  }
  if ([...next.values()].some((ns) => ns.length > 2)) return null;
  const order: string[] = [];
  const seen = new Set<string>();
  for (const start of col) {
    if (seen.has(start) || (next.get(start)?.length ?? 0) > 1) continue;
    let prev: string | null = null;
    let at: string | undefined = start;
    while (at && !seen.has(at)) {
      order.push(at);
      seen.add(at);
      const from: string | null = prev;
      prev = at;
      at = next.get(at)?.find((n) => n !== from);
    }
  }
  // What no chain end reached sits on a cycle.
  if (order.length < col.length) return null;
  return { order, lines };
}

/** A line between two neighbours of the stacked column: straight from the upper's bottom to the lower's top, its words across it. */
function columnLine(e: ViewEdge, a: Rect, b: Rect): Omit<DLine, "edge" | "id" | "dash" | "colour"> {
  const [up, down, upId, downId] = a.y <= b.y ? [a, b, e.from, e.to] : [b, a, e.to, e.from];
  const x = (Math.max(up.x, down.x) + Math.min(up.x + up.w, down.x + down.w)) / 2;
  const points = [
    { x, y: up.y + up.h },
    { x, y: down.y },
  ];
  const box = labelBox(e);
  const mid = (up.y + up.h + down.y) / 2;
  const forward = upId === e.from;
  return {
    d: rounded(points, 8),
    points,
    label: box ? { x: x - (box.width ?? 0) / 2, y: mid - (box.height ?? 0) / 2, w: box.width ?? 0, h: box.height ?? 0, ...labelOf(e) } : null,
    ends: [upId, downId],
    arrowEnd: forward ? e.forward : e.back,
    arrowStart: forward ? e.back : e.forward,
  };
}

/**
 * The view laid out by ELK's layered algorithm, left to right: people, the system, everything outside
 * it, each a partition, with as many layers inside each as its own lines need. Lines are routed
 * orthogonally around the boxes and their labels placed by the engine, so none overlaps another. The
 * algorithm is deterministic: the same view always draws the same picture.
 */
export async function layoutView(v: SystemView): Promise<Diagram> {
  const nodeById = new Map(v.nodes.map((n) => [n.id, n]));
  const column = (id: string) => nodeById.get(id)?.column ?? 1;
  const partition = (c: number) => ({ "elk.partitioning.partition": String(c) });
  const leaf = (n: ViewNode, root: boolean): ElkNode => ({
    id: n.id,
    width: sizeOf(n).w,
    height: sizeOf(n).h,
    ...(root ? { layoutOptions: partition(n.column) } : {}),
  });
  const stack = stackOf(v);
  const inColumn = new Set(stack?.lines.map((e) => e.id) ?? []);
  const stacked = new Map((stack?.order ?? []).map((id, i) => [id, i]));
  const roots = v.nodes.filter((n) => n.frame === null);
  const children: ElkNode[] = [];
  for (const n of [...roots.filter((r) => !stacked.has(r.id)), ...roots.filter((r) => stacked.has(r.id)).sort((a, b) => (stacked.get(a.id) ?? 0) - (stacked.get(b.id) ?? 0))]) {
    children.push(leaf(n, true));
  }
  for (const f of v.frames) {
    children.push({
      id: f.id,
      layoutOptions: { ...partition(f.column), "elk.padding": `[top=${FRAME_PAD.top},left=${FRAME_PAD.side},bottom=${FRAME_PAD.side},right=${FRAME_PAD.side}]` },
      children: v.nodes.filter((n) => n.frame === f.id).map((n) => leaf(n, false)),
    });
  }
  // ELK lays a line out from its source, and partitions only run left to right, so every line is laid
  // out from its leftmost end; the arrowheads keep the direction the design gave it.
  const ends = new Map<string, [string, string]>();
  const edges: ElkExtendedEdge[] = v.edges.filter((e) => !inColumn.has(e.id)).map((e) => {
    const flip = column(e.from) > column(e.to);
    const pair: [string, string] = flip ? [e.to, e.from] : [e.from, e.to];
    ends.set(e.id, pair);
    const label = labelBox(e);
    return { id: e.id, sources: [pair[0]], targets: [pair[1]], labels: label ? [label] : [] };
  });
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.partitioning.activate": "true",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.edgeLabels.placement": "CENTER",
      "elk.spacing.nodeNode": "24",
      "elk.layered.spacing.nodeNodeBetweenLayers": "14",
      "elk.spacing.edgeNode": "16",
      "elk.spacing.edgeEdge": "12",
      "elk.spacing.edgeLabel": "2",
      "elk.layered.spacing.edgeNodeBetweenLayers": "8",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.padding": "[top=8,left=8,bottom=8,right=8]",
      // A stacked column holds its own order, spaced so a line's words fit between two boxes.
      ...(stack
        ? {
            "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
            "elk.spacing.nodeNode": String(Math.max(24, ...stack.lines.map((e) => (labelBox(e)?.height ?? 0) + 16))),
          }
        : {}),
    },
    children,
    edges,
  };
  const out = await (await elk()).layout(graph);

  const origin = new Map<string, Pt>([["root", { x: 0, y: 0 }]]);
  const rect = new Map<string, Rect>();
  const walk = (n: ElkNode, o: Pt) => {
    for (const c of n.children ?? []) {
      const at = { x: o.x + (c.x ?? 0), y: o.y + (c.y ?? 0) };
      rect.set(c.id, { ...at, w: c.width ?? 0, h: c.height ?? 0 });
      origin.set(c.id, at);
      walk(c, at);
    }
  };
  walk(out, { x: 0, y: 0 });

  const boxes: DBox[] = v.nodes.map((n) => ({ ...(rect.get(n.id) ?? { x: 0, y: 0, ...sizeOf(n) }), node: n, lines: linesOf(n) }));
  const frames: DFrame[] = v.frames.map((f) => ({ ...(rect.get(f.id) ?? { x: 0, y: 0, w: 0, h: 0 }), frame: f }));

  const laid: ElkExtendedEdge[] = [];
  const collect = (n: ElkNode) => {
    laid.push(...(n.edges ?? []));
    for (const c of n.children ?? []) collect(c);
  };
  collect(out);
  const byId = new Map(v.edges.map((e) => [e.id, e]));
  const lines: DLine[] = [];
  for (const le of laid) {
    const e = byId.get(le.id);
    const s = le.sections?.[0];
    const pair = ends.get(le.id);
    if (!e || !s || !pair) continue;
    const o = origin.get((le as { container?: string }).container ?? "root") ?? { x: 0, y: 0 };
    const shift = (p: ElkPoint) => ({ x: p.x + o.x, y: p.y + o.y });
    const points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(shift);
    const l = le.labels?.[0];
    const words = labelOf(e);
    const forward = pair[0] === e.from;
    lines.push({
      id: e.id,
      edge: e,
      d: rounded(points, 8),
      points,
      label: l ? { x: (l.x ?? 0) + o.x, y: (l.y ?? 0) + o.y, w: l.width ?? 0, h: l.height ?? 0, ...words } : null,
      ends: pair,
      arrowEnd: forward ? e.forward : e.back,
      arrowStart: forward ? e.back : e.forward,
      ...lineStyle(e.rels),
    });
  }
  for (const e of stack?.lines ?? []) {
    const a = rect.get(e.from);
    const b = rect.get(e.to);
    if (a && b) lines.push({ id: e.id, edge: e, ...columnLine(e, a, b), ...lineStyle(e.rels) });
  }
  settleLabels(lines, boxes);
  return { width: out.width ?? 0, height: out.height ?? 0, boxes, frames, lines };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * ELK reserves each label's room beside its line, clear of every other label. A label is drawn across
 * its own line instead, so parallel lines never leave it unclear which one it names, wherever that
 * clears every other label and box; elsewhere it keeps the engine's place.
 */
function settleLabels(lines: DLine[], boxes: readonly Rect[]) {
  for (const l of lines) {
    if (!l.label) continue;
    const moved = onLine(l.label, l.points);
    const clear = !boxes.some((b) => overlaps(moved, b)) && !lines.some((o) => o !== l && o.label && overlaps(moved, o.label));
    if (clear) l.label = { ...l.label, x: moved.x, y: moved.y };
  }
}

/** The rect moved across the nearest segment of its line until the line runs through its middle. */
function onLine(r: Rect, points: readonly Pt[]): Rect {
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  let best: { d: number; at: Pt } | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Pt;
    const b = points[i] as Pt;
    const level = Math.abs(a.y - b.y) < 0.5;
    const at = level
      ? { x: Math.min(Math.max(c.x, Math.min(a.x, b.x)), Math.max(a.x, b.x)), y: a.y }
      : { x: a.x, y: Math.min(Math.max(c.y, Math.min(a.y, b.y)), Math.max(a.y, b.y)) };
    const d = Math.hypot(at.x - c.x, at.y - c.y);
    if (!best || d < best.d) best = { d, at: level ? { x: c.x, y: a.y } : { x: a.x, y: c.y } };
  }
  return best ? { ...r, x: best.at.x - r.w / 2, y: best.at.y - r.h / 2 } : r;
}

/** The zoom a diagram opens at in a box: as large as fits, at most `max`. */
export const fitZoom = (d: Pick<Diagram, "width" | "height">, box: { width: number; height: number }, max: number) =>
  Math.min(box.width / d.width, box.height / d.height, max);
