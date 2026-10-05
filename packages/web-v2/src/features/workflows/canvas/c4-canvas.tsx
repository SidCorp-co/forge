"use client";

import { type Edge, MarkerType, type Node, useReactFlow } from "@xyflow/react";
import { Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, SegmentedControl } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { refusalsOf } from "@/lib/api/refusals";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { type DBox, type Diagram, fitZoom, layoutView, MIN_READABLE_ZOOM } from "../c4/layout";
import { type Detail, FOCAL, foldable, type Level, relationshipText, viewOf } from "../c4/view";
import { useSystemGraph } from "../hooks";
import { C4_EDGE_TYPES, C4_NODE_TYPES, type C4BoxData, type C4FrameData, type C4LineData } from "./c4-nodes";
import { HEALTH_MARKER_KINDS } from "@forge/contracts/workflow-health";
import { HealthBar, SearchBox, WalkBar } from "./controls";
import { Frame } from "./frame";
import { pathOf, readCanvas, searchSteps, walkOrder } from "./model";
import { DetailPanel, type Selection } from "./panel";
import { hue } from "./style";
import type { WorkflowCanvasProps } from "./workflow-canvas";

const MAX_ZOOM = 2.5;
/** The most a fit enlarges a small diagram. */
const FIT_MAX = 1.25;
const PAD = 16;

const LEVELS = [
  { value: "context" as const, label: "Context", title: "C4 level 1: the system as one box, the people who use it and the systems it talks to" },
  { value: "containers" as const, label: "Containers", title: "C4 level 2: what runs inside the system, and who and what each part talks to" },
];

const DETAILS = [
  { value: "boundaries" as const, label: "Boundaries", title: "Each outside boundary as one box with a count; hover one for its systems" },
  { value: "systems" as const, label: "Every system", title: "Every person and every outside system, each boundary drawn round its own" },
];

const KIND_HUE: Record<DBox["node"]["kind"], string> = { person: "orange", group: "slate", external: "slate", system: "blue", container: "blue", focal: "blue" };

/**
 * A system-context design on the shared canvas, drawn as C4 by one pipeline: graph (core's read model,
 * `GET …/system-graph`) → view (`viewOf`, by level and detail) → layout (`layoutView`, ELK) → nodes and
 * edges here. It opens on Every system when that reads at 12px in the view, else on Boundaries.
 */
export function C4Canvas(props: WorkflowCanvasProps) {
  const { doc, template, diff = null, compact = false, health = null } = props;
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const read = useSystemGraph(props.graph ?? null);
  const graph = read.data ?? null;
  const c = useMemo(() => readCanvas(doc, template), [doc, template]);
  const canFold = useMemo(() => (graph ? foldable(graph) : false), [graph]);
  const [param, setParam] = useQueryParam("level");
  const level: Level = !compact && param === "containers" ? "containers" : "context";
  /** Null until the fit has chosen it for this level. */
  const [detail, setDetail] = useState<Detail | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [walk, setWalk] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [ready, setReady] = useState(false);
  const pendingFit = useRef(true);
  const centreOn = useRef<string | null>(null);

  const viewBox = useCallback(() => {
    const el = wrap.current;
    return el && el.clientWidth > 0 ? { width: el.clientWidth - 2 * PAD, height: el.clientHeight - 2 * PAD } : null;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new level owes a new choice of detail and a fit
  useEffect(() => {
    setDetail(null);
    setOpen(new Set());
    pendingFit.current = true;
  }, [level, graph]);

  useEffect(() => {
    if (detail !== null || !graph) return;
    const all = viewOf(graph, level, "systems");
    if (!all) return;
    if (!canFold) {
      setDetail("systems");
      return;
    }
    let live = true;
    void layoutView(all).then((d) => {
      const box = viewBox();
      if (live) setDetail(box && fitZoom(d, box, FIT_MAX) >= MIN_READABLE_ZOOM ? "systems" : "boundaries");
    });
    return () => {
      live = false;
    };
  }, [detail, graph, level, canFold, viewBox]);

  const view = useMemo(() => (detail && graph ? viewOf(graph, level, detail, open) : null), [graph, level, detail, open]);
  useEffect(() => {
    if (!view) return;
    let live = true;
    void layoutView(view).then((d) => {
      if (live) setDiagram(d);
    });
    return () => {
      live = false;
    };
  }, [view]);

  /**
   * Fit: as large as the view holds, never below the zoom at which the smallest type reads at 12px.
   * Along an axis it cannot hold, the view centres on the system without running past either end.
   */
  const fitTo = useCallback(
    (d: Diagram) => {
      const box = viewBox();
      if (!box) return false;
      const k = Math.max(MIN_READABLE_ZOOM, fitZoom(d, box, FIT_MAX));
      const core = d.boxes.find((b) => b.node.id === FOCAL) ?? d.frames.find((f) => f.frame.id === FOCAL);
      const offset = (size: number, room: number, centre: number) =>
        size * k <= room ? (room - size * k) / 2 : -Math.min(Math.max(centre * k - room / 2, 0), size * k - room);
      const x = PAD + offset(d.width, box.width, core ? core.x + core.w / 2 : d.width / 2);
      const y = PAD + offset(d.height, box.height, core ? core.y + core.h / 2 : d.height / 2);
      void rf.setViewport({ x, y, zoom: k });
      setZoom(k);
      return true;
    },
    [rf, viewBox],
  );

  const boxOfStep = useCallback((d: Diagram, step: string) => d.boxes.find((b) => b.node.steps.includes(step)), []);

  useEffect(() => {
    if (!diagram) return;
    if (pendingFit.current && fitTo(diagram)) {
      pendingFit.current = false;
      setReady(true);
    }
    const id = centreOn.current;
    centreOn.current = null;
    const b = id ? boxOfStep(diagram, id) : undefined;
    if (b) void rf.setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom: rf.getViewport().zoom, duration: 320 });
  }, [diagram, fitTo, rf, boxOfStep]);

  const order = useMemo(() => walkOrder(c), [c]);

  /** Bring a step into view and select it, opening the boundary that folds it. */
  const reveal = (id: string) => {
    setSelection({ step: id });
    const b = diagram ? boxOfStep(diagram, id) : undefined;
    if (b?.node.kind === "group") {
      centreOn.current = id;
      setOpen((prev) => new Set([...prev, b.node.id]));
      return;
    }
    if (b) void rf.setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom: rf.getViewport().zoom, duration: 320 });
  };

  const walkTo = (i: number) => {
    if (i < 0) return;
    if (i >= order.length) {
      setWalk(order.length);
      setSelection(null);
      return;
    }
    setWalk(i);
    reveal(order[i] as string);
  };
  const walkStop = () => {
    setWalk(null);
    setSelection(null);
  };

  const relayout = (next: () => void) => {
    pendingFit.current = true;
    next();
  };
  const foldGroup = useCallback((id: string) => {
    pendingFit.current = true;
    setOpen((prev) => new Set([...prev].filter((x) => x !== id)));
  }, []);

  const onNodeClick = (n: Node) => {
    if (n.type !== "c4box") return;
    const b = (n.data as C4BoxData).box;
    if (b.node.kind === "group") {
      if (!compact) relayout(() => setOpen((prev) => new Set([...prev, b.node.id])));
      return;
    }
    if (b.node.kind === "focal") {
      if (!compact) setParam("containers");
      return;
    }
    if (b.node.node) setSelection({ step: b.node.id });
  };

  const pickEdge = (key: string) => {
    const first = diagram?.lines.find((x) => x.id === key)?.edge.rels[0];
    if (first) setSelection({ edge: first.id });
  };

  const step = selection && "step" in selection ? selection.step : null;
  const edge = selection && "edge" in selection ? selection.edge : null;
  const focus = useMemo(() => {
    if (step) return pathOf(c, step);
    const e = edge ? c.edges.find((x) => x.id === edge) : null;
    return e ? { nodes: new Set([e.from, e.to]), edges: new Set([e.id]) } : null;
  }, [c, step, edge]);
  const hits = useMemo(() => new Set(searchSteps(c, query)), [c, query]);

  const nodes = useMemo((): Node[] => {
    if (!diagram) return [];
    const out: Node[] = diagram.frames.map((f) => {
      const data: C4FrameData = { frame: f, onFold: compact ? null : foldGroup };
      return { id: `frame:${f.frame.id}`, type: "c4frame", position: { x: f.x, y: f.y }, width: f.w, height: f.h, data, zIndex: -1, draggable: false, selectable: false, focusable: false };
    });
    for (const x of diagram.boxes) {
      const ids = x.node.steps;
      const data: C4BoxData = {
        box: x,
        on: step !== null && ids.includes(step),
        rel: !focus || ids.some((s) => focus.nodes.has(s)),
        hit: ids.some((s) => hits.has(s)),
        mark: x.node.node ? (diff?.steps.get(x.node.id) ?? null) : null,
        health: health?.on ? HEALTH_MARKER_KINDS.filter((k) => ids.some((id) => health.nodes.get(id)?.kinds.includes(k))) : [],
        canOpen: !compact,
      };
      out.push({ id: x.node.id, type: "c4box", position: { x: x.x, y: x.y }, width: x.w, height: x.h, data, draggable: false, selectable: false });
    }
    return out;
  }, [diagram, step, focus, hits, diff, compact, foldGroup, health]);

  const edges = useMemo((): Edge[] => {
    if (!diagram) return [];
    return diagram.lines.map((l) => {
      const ids = l.edge.rels.map((r) => r.id);
      const lit = Boolean(focus && ids.some((e) => focus.edges.has(e)));
      const data: C4LineData = { line: l, rows: graph ? l.edge.rels.map((r) => relationshipText(r, graph)) : [], on: edge !== null && ids.includes(edge), lit, dim: Boolean(focus) && !lit };
      const head = { type: MarkerType.ArrowClosed, color: l.colour, width: 14, height: 14 };
      return { id: l.id, source: l.ends[0], target: l.ends[1], type: "c4", data, selectable: false, markerEnd: head, markerStart: head };
    });
  }, [diagram, focus, edge, graph]);

  const el = wrap.current;
  const overflowing = Boolean(diagram && el && (diagram.width * zoom > el.clientWidth - 8 || diagram.height * zoom > el.clientHeight - 8));

  const nodeColor = (n: Node) => (n.type === "c4box" ? hue(KIND_HUE[(n.data as C4BoxData).box.node.kind]) : "transparent");
  const nodeStroke = (n: Node) => (n.type === "c4box" && (n.data as C4BoxData).on ? "var(--accent)" : "transparent");

  const toolbar = (
    <div className="wfc-float wfc-tl" role="toolbar" aria-label="View" data-testid="c4-toolbar">
      {compact ? null : <SegmentedControl<Level> options={LEVELS} value={level} onChange={(v) => setParam(v === "context" ? null : v)} />}
      {canFold && detail ? (
        <>
          {compact ? null : <span className="wfc-sep" />}
          <SegmentedControl<Detail>
            options={DETAILS}
            value={detail}
            onChange={(v) =>
              relayout(() => {
                setOpen(new Set());
                setDetail(v);
              })
            }
          />
        </>
      ) : null}
      {compact ? null : (
        <>
          <span className="wfc-sep" />
          <Button type="button" variant="ghost" size="sm" className="wfc-ib" data-go="true" onClick={() => walkTo(0)} title="Step through the design one element at a time" data-testid="walk-start-bar">
            <Play size={16} />
            <span className="wfc-t">Walk through</span>
          </Button>
        </>
      )}
      {health ? <HealthBar health={health} /> : null}
    </div>
  );

  if (read.error) {
    return (
      <p role="alert" className="m-auto max-w-[72ch] p-6 text-13 text-red" data-testid="system-graph-error">
        {refusalsOf(read.error)[0]?.detail ?? formatApiError(read.error)}
      </p>
    );
  }

  return (
    <Frame
      layout={level === "context" ? "c4-context" : "c4-containers"}
      wrap={wrap}
      template={template}
      nodes={nodes}
      edges={edges}
      nodeTypes={C4_NODE_TYPES}
      edgeTypes={C4_EDGE_TYPES}
      ready={ready && diagram !== null}
      dim={Boolean(focus)}
      zoom={zoom}
      minZoom={MIN_READABLE_ZOOM}
      maxZoom={MAX_ZOOM}
      onNodeClick={onNodeClick}
      onEdgePick={pickEdge}
      onPaneClick={() => setSelection(null)}
      onMove={(vp) => setZoom(vp.zoom)}
      onFit={() => {
        if (diagram) fitTo(diagram);
      }}
      onEscape={() => (walk !== null ? walkStop() : setSelection(null))}
      onArrow={(dir) => {
        if (walk !== null && walk < order.length) walkTo(walk + dir);
      }}
      nodeColor={nodeColor}
      nodeStroke={nodeStroke}
      toolbar={toolbar}
      search={compact ? null : <SearchBox c={c} hits={[...hits]} query={query} onQuery={setQuery} onPick={reveal} />}
      walkBar={!compact && walk !== null && walk < order.length ? <WalkBar at={walk} total={order.length} onWalk={walkTo} onStop={walkStop} /> : null}
      panel={
        compact ? null : (
          <DetailPanel
            canvas={c}
            selection={selection}
            walk={walk === null ? null : { order, at: walk }}
            decision={props.decision}
            onClose={() => (walk !== null ? walkStop() : setSelection(null))}
            onWalk={walkTo}
            onStep={reveal}
            onEdge={(id) => setSelection({ edge: id })}
          />
        )
      }
      compact={compact}
      overflowing={overflowing}
    />
  );
}
