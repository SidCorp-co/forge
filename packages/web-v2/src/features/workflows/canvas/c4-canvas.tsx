"use client";

import { type Edge, MarkerType, type Node, useReactFlow, type Viewport } from "@xyflow/react";
import { Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, SegmentedControl } from "@/design";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { layoutContainers } from "../c4/container-layout";
import { layoutContext } from "../c4/context-layout";
import { type DBox, type Diagram, FONT, MIN_READABLE_ZOOM } from "../c4/geometry";
import { FOCAL, readC4 } from "../c4/model";
import { fitContext, SUMMARY_LEVELS, type SummaryLevel, summarise } from "../c4/summary";
import { C4_EDGE_TYPES, C4_NODE_TYPES, type C4BoundaryData, type C4BoxData, type C4CaptionData, type C4LineData } from "./c4-nodes";
import { SearchBox, WalkBar } from "./controls";
import { Frame } from "./frame";
import { pathOf, searchSteps, walkOrder } from "./model";
import { DetailPanel, type Selection } from "./panel";
import { hue } from "./style";
import type { WorkflowCanvasProps } from "./workflow-canvas";

type Level = "context" | "containers";

/** Zooming a folded Context in past this opens every boundary; back under `FOLD_AT`, it folds again. */
const OPEN_AT = 1.45;
const FOLD_AT = 1.2;
const MAX_ZOOM = 2.5;
/** The most a fit enlarges a small diagram. */
const FIT_MAX = 1.25;
const PAD = 16;

const LEVELS = [
  { value: "context" as const, label: "Context", title: "C4 level 1: the system as one box, the people who use it and the systems it talks to" },
  { value: "containers" as const, label: "Containers", title: "C4 level 2: what runs inside the system, and who and what each part talks to" },
];

const DETAIL = [
  { value: "boundaries" as const, label: "Boundaries", title: "Each outside boundary as one box with a count; hover one for its systems" },
  { value: "systems" as const, label: "Every system", title: "Every person and every outside system — zoom in to get here" },
];

const KIND_HUE: Record<DBox["kind"], string> = { person: "orange", system: "slate", container: "blue", focal: "blue" };

/**
 * A system-context design on the shared canvas, laid out as C4: Context (folded by boundary until the
 * view can read every system) and Containers. The fit picks the least folded Context whose smallest type
 * reads at 12px; zooming in opens the boundaries, and zooming out at that floor folds further instead of
 * drawing smaller.
 */
export function C4Canvas(props: WorkflowCanvasProps) {
  const { doc, template, diff = null, compact = false } = props;
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const m = useMemo(() => readC4(doc, template), [doc, template]);
  const c = m.canvas;
  const [param, setParam] = useQueryParam("level");
  const level: Level = !compact && param === "containers" ? "containers" : "context";
  const [fold, setFold] = useState<SummaryLevel>("boundaries");
  /** Every system drawn: chosen in the toolbar, reached by zooming in, or off. */
  const [systems, setSystems] = useState<"off" | "zoom" | "on">("off");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [containers, setContainers] = useState<Diagram | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [walk, setWalk] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [ready, setReady] = useState(false);
  const pendingFit = useRef(true);
  const anchor = useRef<{ id: string; members: string[]; sx: number; sy: number } | null>(null);
  const centreOn = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    void layoutContainers(m).then((d) => {
      if (live) setContainers(d);
    });
    return () => {
      live = false;
    };
  }, [m]);

  const shown: SummaryLevel = systems !== "off" ? "full" : fold;
  const context = useMemo(() => layoutContext(summarise(m, shown, open)), [m, shown, open]);
  const diagram = level === "context" ? context : containers;
  const foldable = useMemo(() => (summarise(m, "columns").groups?.size ?? 0) > 0, [m]);
  const order = useMemo(() => walkOrder(c), [c]);
  const inFocal = useMemo(() => new Set(m.focal?.parts.map((p) => p.id) ?? []), [m]);
  const stepsOf = useCallback(
    (b: DBox): string[] => (b.step ? [b.step] : b.id === FOCAL ? [...inFocal] : (b.members?.map((x) => x.id) ?? [])),
    [inFocal],
  );

  /** Put a diagram on screen at this zoom: centred when it fits, else centred on the system. */
  const place = useCallback(
    (d: Diagram, k: number) => {
      const el = wrap.current;
      if (!el) return;
      const W = el.clientWidth;
      const H = el.clientHeight;
      const fits = d.width * k <= W - PAD && d.height * k <= H - PAD;
      const core = d.boxes.find((b) => b.id === FOCAL) ?? (d.boundary ? { ...d.boundary } : null);
      const cx = fits || !core ? d.width / 2 : core.x + core.w / 2;
      const cy = fits || !core ? d.height / 2 : core.y + core.h / 2;
      void rf.setViewport({ x: W / 2 - cx * k, y: H / 2 - cy * k, zoom: k });
      setZoom(k);
    },
    [rf],
  );

  /** Fit: the least folded Context that reads at 12px in the view, or the Containers at no less than that. */
  const refit = useCallback(() => {
    const el = wrap.current;
    if (!el || el.clientWidth === 0) return false;
    const box = { width: el.clientWidth - 2 * PAD, height: el.clientHeight - 2 * PAD };
    if (level === "containers") {
      if (!containers) return false;
      place(containers, Math.max(MIN_READABLE_ZOOM, Math.min(box.width / containers.width, box.height / containers.height, FIT_MAX)));
      return true;
    }
    const f = fitContext(m, box, { maxZoom: FIT_MAX });
    if (!f) return false;
    setOpen(new Set());
    if (f.level === "full") setSystems("on");
    else {
      setSystems("off");
      setFold(f.level);
    }
    place(f.diagram, f.zoom);
    return true;
  }, [level, containers, m, place]);

  // The first view, and a view switched to, open fitted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fit is owed once per level, not on every diagram it causes
  useEffect(() => {
    pendingFit.current = true;
  }, [level]);
  useEffect(() => {
    if (!pendingFit.current || !diagram) return;
    if (refit()) {
      pendingFit.current = false;
      setReady(true);
    }
  }, [diagram, refit]);

  /** Keep what the eye is on where it is across the next relayout: this box, or the one nearest the centre. */
  const keep = (id?: string) => {
    const el = wrap.current;
    if (!el || !diagram) return;
    const vp = rf.getViewport();
    const cx = (el.clientWidth / 2 - vp.x) / vp.zoom;
    const cy = (el.clientHeight / 2 - vp.y) / vp.zoom;
    const dist = (b: DBox) => (b.x + b.w / 2 - cx) ** 2 + (b.y + b.h / 2 - cy) ** 2;
    const b = (id ? diagram.boxes.find((x) => x.id === id) : undefined) ?? [...diagram.boxes].sort((p, q) => dist(p) - dist(q))[0];
    if (!b) return;
    anchor.current = { id: b.id, members: b.members?.map((x) => x.id) ?? [], sx: (b.x + b.w / 2) * vp.zoom + vp.x, sy: (b.y + b.h / 2) * vp.zoom + vp.y };
  };
  useEffect(() => {
    if (!diagram) return;
    const vp = rf.getViewport();
    const a = anchor.current;
    anchor.current = null;
    if (a) {
      const b =
        diagram.boxes.find((x) => x.id === a.id) ??
        diagram.boxes.find((x) => a.members.includes(x.id)) ??
        diagram.boxes.find((x) => x.members?.some((y) => y.id === a.id));
      if (b) void rf.setViewport({ x: a.sx - (b.x + b.w / 2) * vp.zoom, y: a.sy - (b.y + b.h / 2) * vp.zoom, zoom: vp.zoom });
    }
    const id = centreOn.current;
    centreOn.current = null;
    const b = id ? diagram.boxes.find((x) => stepsOf(x).includes(id)) : undefined;
    if (b) void rf.setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom: vp.zoom, duration: 320 });
  }, [diagram, rf, stepsOf]);

  /** Bring a step into view and select it, opening the boundary that folds it. */
  const reveal = (id: string) => {
    setSelection({ step: id });
    const g = level === "context" ? diagram?.boxes.find((b) => b.members?.some((x) => x.id === id)) : undefined;
    if (g) {
      centreOn.current = id;
      setOpen((prev) => new Set([...prev, g.id]));
      return;
    }
    const b = diagram?.boxes.find((x) => stepsOf(x).includes(id));
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

  const openGroup = (id: string) => {
    keep(id);
    setOpen((prev) => new Set([...prev, id]));
  };
  const foldGroup = useCallback(
    (id: string) => {
      setOpen((prev) => new Set([...prev].filter((x) => x !== id)));
    },
    [],
  );

  const onNodeClick = (n: Node) => {
    if (n.type !== "c4box") return;
    const b = (n.data as C4BoxData).box;
    if (b.members?.length) {
      if (!compact) openGroup(b.id);
      return;
    }
    if (b.id === FOCAL) {
      if (!compact) setParam("containers");
      return;
    }
    if (b.step) setSelection({ step: b.step });
  };

  const pickEdge = (key: string) => {
    const l = diagram?.lines.find((x) => x.id === key);
    if (l?.edge) setSelection({ edge: l.edge });
  };

  const onMove = (vp: Viewport) => {
    setZoom(vp.zoom);
    if (level !== "context" || !foldable) return;
    if (systems === "off" && vp.zoom >= OPEN_AT) {
      keep();
      setSystems("zoom");
    } else if (systems === "zoom" && vp.zoom < FOLD_AT) {
      keep();
      setSystems("off");
    }
  };

  const zoomBy = (f: number) => {
    const next = rf.getZoom() * f;
    if (level === "context" && next < MIN_READABLE_ZOOM - 1e-6) {
      keep();
      if (systems !== "off") setSystems("off");
      else if (open.size) setOpen(new Set());
      else {
        const i = SUMMARY_LEVELS.indexOf(fold);
        const further = SUMMARY_LEVELS[i + 1];
        if (further) setFold(further);
      }
      void rf.zoomTo(MIN_READABLE_ZOOM, { duration: 160 });
      return;
    }
    void rf.zoomTo(Math.min(MAX_ZOOM, Math.max(MIN_READABLE_ZOOM, next)), { duration: 160 });
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
    const out: Node[] = [];
    const b = diagram.boundary;
    if (b) {
      const data: C4BoundaryData = { boundary: b };
      out.push({ id: "c4:boundary", type: "c4boundary", position: { x: b.x, y: b.y }, width: b.w, height: b.h, data, zIndex: -1, draggable: false, selectable: false, focusable: false });
    }
    for (const cap of diagram.captions) {
      const size = cap.tone === "heading" ? FONT.heading : FONT.group;
      const data: C4CaptionData = { caption: cap, onFold: compact ? null : foldGroup };
      out.push({
        id: `c4:cap:${cap.text}@${Math.round(cap.x)},${Math.round(cap.y)}`,
        type: "c4caption",
        position: { x: cap.x - (cap.folds && !compact ? 20 : 0), y: cap.y - size * 1.15 },
        data,
        draggable: false,
        selectable: false,
        focusable: false,
      });
    }
    for (const x of diagram.boxes) {
      const ids = stepsOf(x);
      const data: C4BoxData = {
        box: x,
        on: step !== null && ids.includes(step),
        rel: !focus || ids.some((s) => focus.nodes.has(s)),
        hit: ids.some((s) => hits.has(s)),
        mark: x.step ? (diff?.steps.get(x.step) ?? null) : null,
        canOpen: !compact,
      };
      out.push({ id: x.id, type: "c4box", position: { x: x.x, y: x.y }, width: x.w, height: x.h, data, draggable: false, selectable: false });
    }
    return out;
  }, [diagram, stepsOf, step, focus, hits, diff, compact, foldGroup]);

  const edges = useMemo((): Edge[] => {
    if (!diagram) return [];
    return diagram.lines.map((l) => {
      const lit = Boolean(focus && l.edges.some((e) => focus.edges.has(e)));
      const data: C4LineData = { line: l, on: edge !== null && l.edges.includes(edge), lit, dim: Boolean(focus) && !lit };
      const head = { type: MarkerType.ArrowClosed, color: l.colour, width: 14, height: 14 };
      return { id: l.id, source: l.ends[0], target: l.ends[1], type: "c4", data, selectable: false, markerEnd: head, markerStart: head };
    });
  }, [diagram, focus, edge]);

  const el = wrap.current;
  const overflowing = Boolean(diagram && el && (diagram.width * zoom > el.clientWidth - 8 || diagram.height * zoom > el.clientHeight - 8));

  const nodeColor = (n: Node) => (n.type === "c4box" ? hue(KIND_HUE[(n.data as C4BoxData).box.kind]) : "transparent");
  const nodeStroke = (n: Node) => (n.type === "c4box" && (n.data as C4BoxData).on ? "var(--accent)" : "transparent");

  const toolbar = (
    <div className="wfc-float wfc-tl" role="toolbar" aria-label="View" data-testid="c4-toolbar">
      {compact ? null : <SegmentedControl<Level> options={LEVELS} value={level} onChange={(v) => setParam(v === "context" ? null : v)} />}
      {level === "context" && foldable ? (
        <>
          {compact ? null : <span className="wfc-sep" />}
          <SegmentedControl<"boundaries" | "systems">
            options={DETAIL}
            value={systems === "off" ? "boundaries" : "systems"}
            onChange={(v) => {
              keep();
              setOpen(new Set());
              setSystems(v === "systems" ? "on" : "off");
            }}
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
    </div>
  );

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
      onMove={onMove}
      onFit={() => void refit()}
      onZoom={zoomBy}
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
