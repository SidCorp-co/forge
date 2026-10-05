"use client";

import type { Node, Viewport } from "@xyflow/react";
import { useReactFlow } from "@xyflow/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { type Language, SearchBox, ViewBar, WalkBar } from "./controls";
import { EDGE_TYPES } from "./edges";
import { Frame } from "./frame";
import { pathOf, readCanvas, searchSteps, walkOrder } from "./model";
import { type BandRowData, NODE_TYPES, type StepNodeData } from "./nodes";
import { DetailPanel, type Selection } from "./panel";
import { hue, tint } from "./style";
import { useCanvasLayout } from "./use-canvas-layout";
import { buildView, type Lod, lodOf } from "./view";
import type { WorkflowCanvasProps } from "./workflow-canvas";

/** A design laid out by ELK from its template: bands, stages and steps, levels of detail by zoom. */
export function FlowCanvas(props: WorkflowCanvasProps) {
  const { doc, template, diff = null, health = null } = props;
  const rf = useReactFlow();
  const c = useMemo(() => readCanvas(doc, template), [doc, template]);
  const banded = c.bands.length > 0;
  const order = useMemo(() => walkOrder(c), [c]);
  const [language, setLanguage] = useState<Language>("business");
  const [lod, setLod] = useState<Lod>(1);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<Selection>(null);
  const [walk, setWalk] = useState<number | null>(null);
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const wrap = useRef<HTMLDivElement>(null);

  const view = useMemo(() => buildView(c, { lod, expanded, open }), [c, lod, expanded, open]);
  const structure = useMemo(
    () => `${language}|${view.nodes.map((n) => (n.kind === "step" ? `${n.key}:${n.full ? 1 : 0}` : n.key)).join(",")}`,
    [language, view],
  );
  const hits = useMemo(() => new Set(searchSteps(c, query)), [c, query]);
  const selectedStep = selection && "step" in selection ? selection.step : null;
  const selectedEdge = selection && "edge" in selection ? selection.edge : null;
  const focus = useMemo(() => {
    if (selectedStep) return pathOf(c, selectedStep);
    const e = selectedEdge ? c.edges.find((x) => x.id === selectedEdge || `agg:${x.from}>${x.to}` === selectedEdge) : null;
    return e ? { nodes: new Set([e.from, e.to]), edges: new Set([e.id]) } : null;
  }, [c, selectedStep, selectedEdge]);
  const decoration = useMemo(
    () => ({
      selected: selectedStep,
      selectedEdge,
      relNodes: focus?.nodes ?? null,
      relEdges: focus?.edges ?? null,
      hits,
      visited: walk === null ? new Set<string>() : new Set(visited),
      contract: language === "contract",
      diff,
      health,
    }),
    [selectedStep, selectedEdge, focus, hits, walk, visited, language, diff, health],
  );

  const layout = useCanvasLayout({
    c,
    view,
    structure,
    decoration,
    direction: template?.layout.direction ?? (doc.kind === "state" ? "down" : "right"),
    openBands: expanded,
    onToggleBand: toggleBand,
    onLaidOut: (first, size) => {
      if (!first) return;
      const el = wrap.current;
      if (!el) return;
      const fitK = Math.min((el.clientWidth - 40) / size.width, (el.clientHeight - 40) / size.height, 1);
      const k = Math.min(1, Math.max(fitK, 0.85));
      void rf.setViewport({ x: (el.clientWidth - size.width * k) / 2, y: 64, zoom: k });
      setZoom(k);
    },
  });

  const centerAnchor = useCallback(() => {
    const el = wrap.current;
    if (!el || !layout.positions) return null;
    const vp = rf.getViewport();
    let best: string | null = null;
    let bd = Number.POSITIVE_INFINITY;
    for (const [k, p] of layout.positions) {
      const cx = (p.x + p.width / 2) * vp.zoom + vp.x - el.clientWidth / 2;
      const cy = (p.y + p.height / 2) * vp.zoom + vp.y - el.clientHeight / 2;
      if (cx * cx + cy * cy < bd) {
        bd = cx * cx + cy * cy;
        best = k;
      }
    }
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
    setSelection({ step: id });
    if (needBand || needOpen) {
      layout.keep(centerAnchor());
      if (needBand && band) setExpanded((prev) => new Set([...prev, band]));
      if (lod === 0) setLod(1);
      if (needOpen) setOpen((prev) => new Set([...prev, id]));
    }
    layout.center(id, needBand || needOpen);
  };

  const walkTo = (i: number) => {
    if (i < 0) return;
    if (i >= order.length) {
      setWalk(order.length);
      setSelection(null);
      return;
    }
    const id = order[i] as string;
    setWalk(i);
    setVisited((prev) => new Set([...prev, id]));
    reveal(id);
  };
  const walkStop = () => {
    setWalk(null);
    setVisited(new Set());
    setSelection(null);
  };

  const clickStep = (id: string) => {
    if (selectedStep === id && lod < 2 && open.has(id)) {
      layout.keep(layout.anchorFor([id]));
      setOpen((prev) => new Set([...prev].filter((x) => x !== id)));
      return;
    }
    setSelection({ step: id });
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
    setSelection({ edge: e.src[0]?.id ?? key });
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


  const nodeColor = (n: Node) => {
    if (n.type === "bandRow") {
      const d = n.data as BandRowData;
      return tint(d.colour, d.odd ? 14 : 22, "var(--bg-surface)");
    }
    if (n.type === "band") return "var(--fg-subtle)";
    return hue((n.data as StepNodeData).type.colour);
  };
  const nodeStroke = (n: Node) => {
    if (n.type !== "step") return "transparent";
    const d = n.data as StepNodeData;
    return d.on ? "var(--accent)" : d.hit ? "var(--wf-hit)" : "transparent";
  };

  return (
    <Frame
      layout="flow"
      wrap={wrap}
      template={template}
      nodes={layout.nodes}
      edges={layout.edges}
      onNodesChange={layout.onNodesChange}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      ready={layout.ready}
      dim={Boolean(focus)}
      zoom={zoom}
      minZoom={0.2}
      maxZoom={2}
      onNodeClick={(n) => onNodeClick(null, n)}
      onEdgePick={pickEdge}
      onPaneClick={() => setSelection(null)}
      onMove={(vp) => onMove(null, vp)}
      onFit={() => void rf.fitView({ duration: 240, padding: 0.08 })}
      onEscape={() => (walk !== null ? walkStop() : setSelection(null))}
      onArrow={(dir) => {
        if (walk !== null && walk < order.length) walkTo(walk + dir);
      }}
      nodeColor={nodeColor}
      nodeStroke={nodeStroke}
      toolbar={<ViewBar language={language} lod={lod} banded={banded} allOpen={allOpen} onLanguage={setLanguage} onLod={setLevel} onToggleAll={toggleAll} onWalk={() => walkTo(0)} health={health} />}
      search={<SearchBox c={c} hits={[...hits]} query={query} onQuery={setQuery} onPick={reveal} />}
      walkBar={walk !== null && walk < order.length ? <WalkBar at={walk} total={order.length} onWalk={walkTo} onStop={walkStop} /> : null}
      panel={
        <DetailPanel
          canvas={c}
          selection={selection}
          walk={walk === null ? null : { order, at: walk }}
          decision={props.decision}
          onClose={() => (walk !== null ? walkStop() : setSelection(null))}
          onWalk={walkTo}
          onStep={reveal}
          onEdge={(id) => setSelection({ edge: id })}
          health={health}
        />
      }
    />
  );
}
