import { type Canvas, type CanvasEdge, edgeText, lineLabel, titleOf } from "./model";

/** 0 stages only · 1 step titles · 2 full cards; zoom decides it, at these scales. */
export type Lod = 0 | 1 | 2;
const LOD_AT: readonly [number, number] = [0.45, 0.95];
export const lodOf = (zoom: number): Lod => (zoom < LOD_AT[0] ? 0 : zoom < LOD_AT[1] ? 1 : 2);

interface ViewState {
  lod: Lod;
  /** Bands shown as their steps; every other band is folded into its summary card. */
  expanded: ReadonlySet<string>;
  /** Steps shown as full cards below level 2. */
  open: ReadonlySet<string>;
}

export type ViewNode =
  | { key: string; kind: "step"; id: string; band: string | null; full: boolean }
  | { key: string; kind: "band"; band: string };

/** A drawn line: one design line, or the lines between two folded bands merged into one. */
export interface ViewEdge {
  key: string;
  from: string;
  to: string;
  src: CanvasEdge[];
  merged: boolean;
}

export interface View {
  nodes: ViewNode[];
  edges: ViewEdge[];
  keyOf: Map<string, string>;
}

const bandKey = (band: string) => `band:${band}`;

export function buildView(c: Canvas, s: ViewState): View {
  const nodes: ViewNode[] = [];
  const keyOf = new Map<string, string>();
  const step = (id: string, band: string | null) => {
    nodes.push({ key: id, kind: "step", id, band, full: s.lod === 2 || s.open.has(id) });
    keyOf.set(id, id);
  };
  if (c.bands.length === 0) {
    for (const st of c.doc.steps) step(st.id, null);
  } else {
    for (const b of c.bands) {
      if (s.lod >= 1 && s.expanded.has(b.id)) {
        for (const id of b.steps) step(id, b.id);
      } else {
        nodes.push({ key: bandKey(b.id), kind: "band", band: b.id });
        for (const id of b.steps) keyOf.set(id, bandKey(b.id));
      }
    }
  }
  const edges: ViewEdge[] = [];
  const merged = new Map<string, ViewEdge>();
  for (const e of c.edges) {
    const from = keyOf.get(e.from);
    const to = keyOf.get(e.to);
    if (!from || !to || from === to) continue;
    if (from === e.from && to === e.to) {
      edges.push({ key: e.id, from, to, src: [e], merged: false });
      continue;
    }
    if (e.kind.direction === "return") continue;
    const key = `agg:${from}>${to}`;
    const seen = merged.get(key);
    if (seen) seen.src.push(e);
    else {
      const m = { key, from, to, src: [e], merged: true };
      merged.set(key, m);
      edges.push(m);
    }
  }
  return { nodes, edges, keyOf };
}

/**
 * A merged line's words: the first line's own words and "+N more", never a count of links (REQ-12 BC-9);
 * `full`, for the hover, lists every line it stands for.
 */
export function mergedLabel(e: ViewEdge, c: Canvas): { text: string; full: string } {
  const first = e.src[0];
  const words = first ? lineLabel(first).text || first.kind.label : "";
  const more = e.src.length - 1;
  const name = (id: string) => {
    const s = c.steps.get(id);
    return s ? titleOf(s) : id;
  };
  return {
    text: more > 0 ? `${words} +${more} more` : words,
    full: e.src.map((s) => `${name(s.from)} → ${name(s.to)}: ${edgeText(s) || s.kind.label}`).join("\n"),
  };
}
