"use client";

import type { Node, Viewport } from "@xyflow/react";
import { useReactFlow } from "@xyflow/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { type Language, ViewBar } from "./controls";
import { EDGE_TYPES } from "./edges";
import { Frame } from "./frame";
import { useCanvasModel } from "./model";
import { type BandRowData, NODE_TYPES, type StepNodeData } from "./nodes";
import { hue, tint } from "./style";
import { useCanvasLayout } from "./use-canvas-layout";
import { focusChrome, litOf, useStepFocus } from "./step-focus";
import { buildView, type Lod, lodOf } from "./view";
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

/** A design laid out by ELK from its template: bands, stages and steps, levels of detail by zoom. */
export function FlowCanvas(props: WorkflowCanvasProps) {
  const { doc, template, diff = null, health = null, highlight = null } = props;
  const rf = useReactFlow();
  const c = useCanvasModel(doc, template);
  const banded = c.bands.length > 0;
  const f = useStepFocus(c);
  const { focus, hits, walk } = f;
  const lit = useMemo(() => litOf(focus, highlight), [focus, highlight]);
  const [language, setLanguage] = useState<Language>("business");
  const [lod, setLod] = useState<Lod>(1);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const wrap = useRef<HTMLDivElement>(null);

  const view = useMemo(() => buildView(c, { lod, expanded, open }), [c, lod, expanded, open]);
  const structure = useMemo(
    () => `${language}|${view.nodes.map((n) => (n.kind === "step" ? `${n.key}:${n.full ? 1 : 0}` : n.key)).join(",")}`,
    [language, view],
  );
  const decoration = useMemo(
    () => ({
      selected: f.step,
      selectedEdge: f.edge,
      relNodes: lit?.nodes ?? null,
      relEdges: lit?.edges ?? null,
      traced: highlight?.steps ?? null,
      hits,
      visited: walk === null ? new Set<string>() : new Set(f.visited),
      contract: language === "contract",
      diff,
      health,
    }),
    [f.step, f.edge, lit, highlight, hits, walk, f.visited, language, diff, health],
  );

  const layout = useCanvasLayout({
    c,
    view,
    structure,
    decoration,
    direction: template?.layout.direction ?? (doc.kind === "state" ? "down" : "right"),
    openBands: expanded,
    onToggleBand: toggleBand,
    onLaidOut: (first, size, positions) => {
      if (!first || !wrap.current) return;
      const vp = openingView(wrap.current, size, [...(highlight?.steps ?? [])].flatMap((id) => positions.get(view.keyOf.get(id) ?? id) ?? []));
      void rf.setViewport(vp);
      setZoom(vp.zoom);
    },
  });

  const centerAnchor = useCallback(() => {
    const el = wrap.current;
    if (!el || !layout.positions) return null;
    const best = nearestCentre(layout.positions, rf.getViewport(), el);
    if (!best) return null;
    const band = view.nodes.find((n) => n.key === best);
    return layout.anchorFor(band?.kind === "band" ? (c.bands.find((b) => b.id === band.band)?.steps ?? [best]) : [best]);
  }, [layout, rf, view, c]);

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

  const onMove = (_: unknown, vp: Viewport) => {
    setZoom(vp.zoom);
    if (!banded) return;
    const next = lodOf(vp.zoom);
    if (next !== lod) {
      layout.keep(centerAnchor());
      setLod(next);
    }
  };

  const setLevel = (l: Lod) => {
    if (l === lod) return;
    const el = wrap.current;
    if (l > 0 && expanded.size === 0) setExpanded(new Set(c.bands.map((b) => b.id)));
    layout.keep(centerAnchor());
    setLod(l);
    const vp = rf.getViewport();
    const k = l === 0 ? Math.min(vp.zoom, 0.4) : l === 1 ? 0.75 : 1.05;
    const cx = (el?.clientWidth ?? 0) / 2;
    const cy = (el?.clientHeight ?? 0) / 2;
    void rf.setViewport({ x: cx - ((cx - vp.x) * k) / vp.zoom, y: cy - ((cy - vp.y) * k) / vp.zoom, zoom: k });
  };

  const allOpen = banded && lod >= 1 && c.bands.every((b) => expanded.has(b.id));
  const toggleAll = () => {
    layout.keep(centerAnchor());
    if (allOpen) {
      setExpanded(new Set());
      setOpen(new Set());
    } else {
      setExpanded(new Set(c.bands.map((b) => b.id)));
      if (lod === 0) setLod(1);
    }
  };

  return (
    <Frame
      layout="flow"
      compact={props.compact ?? false}
      wrap={wrap}
      template={template}
      nodes={layout.nodes}
      edges={layout.edges}
      onNodesChange={layout.onNodesChange}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      ready={layout.ready}
      zoom={zoom}
      minZoom={0.2}
      maxZoom={2}
      onNodeClick={(n) => onNodeClick(null, n)}
      onEdgePick={pickEdge}
      onMove={(vp) => onMove(null, vp)}
      onFit={() => void rf.fitView({ duration: 240, padding: 0.08 })}
      nodeColor={nodeColor}
      nodeStroke={nodeStroke}
      toolbar={<ViewBar language={language} lod={lod} banded={banded} allOpen={allOpen} onLanguage={setLanguage} onLod={setLevel} onToggleAll={toggleAll} onWalk={() => walkTo(0)} health={health} changes={props.changes} focus={props.focus} />}
      {...frameFocus}
    />
  );
}
