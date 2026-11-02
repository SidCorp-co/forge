
import type { Node, Viewport } from "@xyflow/react";
import { useReactFlow } from "@xyflow/react";
import { useMemo, useRef, useState } from "react";
import { useRecordView } from "@/design";
import { type Language, ViewBar } from "./controls";
import { EDGE_TYPES } from "./edges";
import { Frame } from "./frame";
import { type Canvas, useCanvasModel } from "./model";
import { type BandRowData, NODE_TYPES, type StepNodeData } from "./nodes";
import { hue, tint } from "./style";
import { useCanvasLayout } from "./use-canvas-layout";
import { focusChrome, type Lit, litOf, useStepFocus } from "./step-focus";
import { buildView, type Lod, lodOf, type View } from "./view";
import type { WorkflowCanvasProps } from "./workflow-canvas";

function nearestCentre(positions: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>, vp: Viewport, el: HTMLElement): string | null {
  let best: string | null = null;
  let bd = Number.POSITIVE_INFINITY;
  for (const [k, p] of positions) {
    const cx = (p.x + p.width / 2) * vp.zoom + vp.x - el.clientWidth / 2;
    const cy = (p.y + p.height / 2) * vp.zoom + vp.y - el.clientHeight / 2;
    if (cx * cx + cy * cy < bd) {
      bd = cx * cx + cy * cy;
      best = k;
    }
  }
  return best;
}

function nodeColor(n: Node) {
  if (n.type === "bandRow") {
    const d = n.data as BandRowData;
    return tint(d.colour, d.odd ? 14 : 22, "var(--bg-surface)");
  }
  if (n.type === "band") return "var(--fg-subtle)";
  return hue((n.data as StepNodeData).type.colour);
}
function nodeStroke(n: Node) {
  if (n.type !== "step") return "transparent";
  const d = n.data as StepNodeData;
  return d.on ? "var(--accent)" : d.hit ? "var(--wf-hit)" : "transparent";
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Where the canvas opens: on a page's highlight, the lit steps fitted and centred, never past their
 * own size; else the design from its top, fitted to the width and no smaller than 0.85.
 */
function openingView(el: HTMLElement, size: { width: number; height: number }, lit: readonly Box[]): Viewport {
  if (lit.length > 0) {
    const x0 = Math.min(...lit.map((p) => p.x));
    const y0 = Math.min(...lit.map((p) => p.y));
    const w = Math.max(...lit.map((p) => p.x + p.width)) - x0;
    const h = Math.max(...lit.map((p) => p.y + p.height)) - y0;
    const k = Math.max(0.4, Math.min((el.clientWidth - 80) / w, (el.clientHeight - 120) / h, 1));
    return { x: el.clientWidth / 2 - (x0 + w / 2) * k, y: el.clientHeight / 2 - (y0 + h / 2) * k, zoom: k };
  }
  const fitK = Math.min((el.clientWidth - 40) / size.width, (el.clientHeight - 40) / size.height, 1);
  const k = Math.min(1, Math.max(fitK, 0.85));
  return { x: (el.clientWidth - size.width * k) / 2, y: 64, zoom: k };
}

/** A compact pane's top row, where its walk-through button stands above the drawing. */
const COMPACT_TOP = 56;
const COMPACT_PAD = 16;
/** The smallest zoom a compact pane draws at: a step's name stays readable, and a wider drawing scrolls sideways. */
const COMPACT_READABLE = 0.8;

/**
 * Where a compact pane (a requirement's picture) opens, and how tall it is: the whole drawing fitted to
 * the width, never above its own size nor below a readable zoom; a drawing wider than that starts at its
 * first step, never cut at the pane's left edge, and scrolls sideways. The height follows the drawing,
 * so no band stands empty above or below it (ISS-903).
 */
export function compactView(width: number, boxes: readonly Box[]): { viewport: Viewport; height: number } {
  // the drawing's own bounds: a layout's size carries margins around its nodes, which drew as empty bands
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const w = Math.max(...boxes.map((b) => b.x + b.width)) - x0;
  const h = Math.max(...boxes.map((b) => b.y + b.height)) - y0;
  const zoom = Math.min(1, Math.max(COMPACT_READABLE, (width - 2 * COMPACT_PAD) / w));
  const drawn = w * zoom;
  const room = width - 2 * COMPACT_PAD;
  // wider than the pane: from the drawing's first step, the lit ones lit wherever they stand, and the rest a sideways scroll away
  const left = drawn <= room ? (width - drawn) / 2 : COMPACT_PAD;
  return { viewport: { x: left - x0 * zoom, y: COMPACT_TOP - y0 * zoom, zoom }, height: Math.ceil(COMPACT_TOP + h * zoom + COMPACT_PAD) };
}

/** What a relayout is keyed on: the language, and each node with whether a step shows in full. */
const structureOf = (language: Language, view: View) => `${language}|${view.nodes.map((n) => (n.kind === "step" ? `${n.key}:${n.full ? 1 : 0}` : n.key)).join(",")}`;

/** The parts of the step focus a node's marks read; never the whole focus, which is a new object each render. */
type FocusMarks = Pick<ReturnType<typeof useStepFocus>, "step" | "edge" | "hits" | "walk" | "visited">;

/** What the canvas marks on its nodes: the selection, what relates to it, the walk, the diff and health. */
function decorationOf(f: FocusMarks, lit: Lit | null, o: Pick<WorkflowCanvasProps, "highlight" | "diff" | "health"> & { language: Language }) {
  return {
    selected: f.step,
    selectedEdge: f.edge,
    relNodes: lit?.nodes ?? null,
    relEdges: lit?.edges ?? null,
    traced: o.highlight?.steps ?? null,
    hits: f.hits,
    visited: f.walk === null ? new Set<string>() : new Set(f.visited),
    contract: o.language === "contract",
    diff: o.diff ?? null,
    health: o.health ?? null,
  };
}

/**
 * The decoration, kept while what it reads holds. Keyed on the parts of the focus it reads, never on
 * the focus itself: a new decoration each render re-sets the nodes, which renders again.
 */
function useDecoration({ step, edge, hits, walk, visited }: FocusMarks, lit: Lit | null, { highlight, language, diff, health }: Parameters<typeof decorationOf>[2]) {
  return useMemo(
    () => decorationOf({ step, edge, hits, walk, visited }, lit, { highlight, language, diff, health }),
    [step, edge, hits, walk, visited, lit, highlight, language, diff, health],
  );
}

/**
 * What a design opens with: every stage open and every step a full card saying what it does and who
 * owns it, its lines saying what it leads to (REQ-10 BC-15); zoom and Fold all still fold it. A step or
 * stage the design gains while shown (the changes switch draws removed ones) opens too.
 */
export function useOpenDesign(c: Canvas, compact = false) {
  const bands = c.bands.map((b) => b.id);
  // a compact pane (a requirement's picture) draws each step by its title, its purpose the card's
  // hover and a click away; the design's own page opens every step in full (ISS-903)
  const steps = compact ? [] : c.doc.steps.map((st) => st.id);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(bands));
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(steps));
  const drawn = `${bands.join(",")}|${c.doc.steps.map((st) => st.id).join(",")}`;
  const [drawnWas, setDrawnWas] = useState(drawn);
  if (drawnWas !== drawn) {
    setDrawnWas(drawn);
    setExpanded((prev) => new Set([...prev, ...bands]));
    setOpen((prev) => new Set([...prev, ...steps]));
  }
  return { expanded, setExpanded, open, setOpen };
}

/** A design laid out by ELK from its template: bands, stages and steps, levels of detail by zoom. */
export function FlowCanvas(props: WorkflowCanvasProps) {
  const { doc, template, diff = null, health = null, highlight = null } = props;
  const rf = useReactFlow();
  const c = useCanvasModel(doc, template);
  const banded = c.bands.length > 0;
  const f = useStepFocus(c);
  const lit = useMemo(() => litOf(f.focus, highlight), [f.focus, highlight]);
  // contract terms are the Developer view's, the page's one switch for agent text (REQ-43 BC-7)
  const [recordView] = useRecordView();
  const language: Language = recordView === "developer" ? "contract" : "business";
  const [lod, setLod] = useState<Lod>(1);
  const { expanded, setExpanded, open, setOpen } = useOpenDesign(c, props.compact ?? false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const view = useMemo(() => buildView(c, { lod, expanded, open }), [c, lod, expanded, open]);
  const structure = useMemo(() => structureOf(language, view), [language, view]);
  const decoration = useDecoration(f, lit, { highlight, language, diff, health });

  const layout = useCanvasLayout({
    c,
    view,
    structure,
    decoration,
    direction: template?.layout.direction ?? (doc.kind === "state" ? "down" : "right"),
    openBands: expanded,
    onToggleBand: toggleBand,
    onLaidOut: (first, size, positions) => {
      if (!first || !wrapRef.current) return;
      const litBoxes = [...(highlight?.steps ?? [])].flatMap((id) => positions.get(view.keyOf.get(id) ?? id) ?? []);
      if (props.compact && props.onFitted && positions.size > 0) {
        const fitted = compactView(wrapRef.current.clientWidth, [...positions.values()]);
        void rf.setViewport(fitted.viewport);
        props.onFitted(fitted.height);
        return;
      }
      void rf.setViewport(openingView(wrapRef.current, size, litBoxes));
    },
  });

  const centerAnchor = () => {
    const el = wrapRef.current;
    const best = el && layout.positions ? nearestCentre(layout.positions, rf.getViewport(), el) : null;
    if (!best) return null;
    const band = view.nodes.find((n) => n.key === best);
    return layout.anchorFor(band?.kind === "band" ? (c.bands.find((b) => b.id === band.band)?.steps ?? [best]) : [best]);
  };

  const openBands = (bands: string[], anchorIds: string[]) => {
    layout.keep(layout.anchorFor(anchorIds) ?? centerAnchor());
    setExpanded((prev) => new Set([...prev, ...bands]));
    if (lod === 0) {
      setLod(1);
      const vp = rf.getViewport();
      if (vp.zoom < 0.62) void rf.setViewport({ ...vp, zoom: 0.62 });
    }
  };

  function toggleBand(b: string) {
    const steps = c.bands.find((x) => x.id === b)?.steps ?? [];
    if (lod >= 1 && expanded.has(b)) {
      layout.keep(layout.anchorFor(steps.slice(0, 1)) ?? centerAnchor());
      setExpanded((prev) => new Set([...prev].filter((x) => x !== b)));
      return;
    }
    openBands([b], steps);
  }

  /** Bring a step into view, open, selected and centred, unfolding what hides it. */
  const reveal = (id: string) => {
    const band = c.bandOf.get(id);
    const needBand = banded && band !== undefined && (!expanded.has(band) || lod === 0);
    const needOpen = lod < 2 && !open.has(id);
    f.setSelection({ step: id });
    if (needBand || needOpen) {
      layout.keep(centerAnchor());
      if (needBand && band) setExpanded((prev) => new Set([...prev, band]));
      if (lod === 0) setLod(1);
      if (needOpen) setOpen((prev) => new Set([...prev, id]));
    }
    layout.center(id, needBand || needOpen);
  };

  const { walkTo, ...frameFocus } = focusChrome(f, { c, reveal, decision: props.decision, compact: props.compact ?? false, health, focus: props.focus, highlight });

  const clickStep = (id: string) => {
    if (f.step === id && lod < 2 && open.has(id)) {
      layout.keep(layout.anchorFor([id]));
      setOpen((prev) => new Set([...prev].filter((x) => x !== id)));
      return;
    }
    f.setSelection({ step: id });
    if (lod < 2 && !open.has(id)) {
      layout.keep(layout.anchorFor([id]));
      setOpen((prev) => new Set([...prev, id]));
    }
  };

  const onNodeClick = (_: unknown, n: Node) => {
    if (n.type === "step") clickStep((n.data as StepNodeData).step.id);
    else if (n.type === "band") {
      const b = view.nodes.find((x) => x.key === n.id);
      if (b?.kind === "band") toggleBand(b.band);
    }
  };

  const pickEdge = (key: string) => {
    const e = view.edges.find((x) => x.key === key);
    if (!e) return;
    if (e.merged) {
      const bands = [...new Set(e.src.flatMap((s) => [c.bandOf.get(s.from), c.bandOf.get(s.to)]).filter((b): b is string => Boolean(b)))];
      openBands(bands, e.src.map((s) => s.from));
      return;
    }
    f.setSelection({ edge: e.src[0]?.id ?? key });
  };

  const onMove = (vp: Viewport) => {
    if (!banded) return;
    const next = lodOf(vp.zoom);
    if (next !== lod) {
      layout.keep(centerAnchor());
      setLod(next);
    }
  };

  const allOpen = banded && lod >= 1 && c.bands.every((b) => expanded.has(b.id));
  const toggleAll = () => {
    layout.keep(centerAnchor());
    if (allOpen) {
      setExpanded(new Set());
      setOpen(new Set());
    } else {
      setExpanded(new Set(c.bands.map((b) => b.id)));
      setOpen(new Set(c.doc.steps.map((st) => st.id)));
      if (lod === 0) setLod(1);
    }
  };

  return (
    <Frame
      layout="flow"
      compact={props.compact ?? false}
      wrap={wrapRef}
      template={template}
      nodes={layout.nodes}
      edges={layout.edges}
      onNodesChange={layout.onNodesChange}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      ready={layout.ready}
      minZoom={0.2}
      maxZoom={2}
      onNodeClick={(n) => onNodeClick(null, n)}
      onEdgePick={pickEdge}
      onMove={onMove}
      onFit={() => void rf.fitView({ duration: 240, padding: 0.08 })}
      nodeColor={nodeColor}
      nodeStroke={nodeStroke}
      toolbar={<ViewBar banded={banded} allOpen={allOpen} onToggleAll={toggleAll} onWalk={() => walkTo(0)} health={health} changes={props.changes} />}
      {...frameFocus}
    />
  );
}
