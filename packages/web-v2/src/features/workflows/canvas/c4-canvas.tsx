"use client";

import { type Edge, MarkerType, type Node, useReactFlow } from "@xyflow/react";
import { Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, SegmentedControl } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { refusalsOf } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { type DBox, type Diagram, fitZoom, layoutView, MIN_READABLE_ZOOM } from "../c4/layout";
import { type Detail, FOCAL, foldable, type Level, relationshipText, viewOf } from "../c4/view";
import { useSystemGraph } from "../hooks";
import type { SystemGraph } from "../types";
import { C4_EDGE_TYPES, C4_NODE_TYPES, type C4BoxData, type C4FrameData, type C4LineData } from "./c4-nodes";
import { HEALTH_MARKER_KINDS } from "@forge/contracts/workflow-health";
import { HealthBar, PageBar } from "./controls";
import { Frame } from "./frame";
import { useCanvasModel } from "./model";
import { hue } from "./style";
import { focusChrome, useStepFocus } from "./step-focus";
import type { WorkflowCanvasProps } from "./workflow-canvas";

const MAX_ZOOM = 2.5;
/** The most a fit enlarges a small diagram. */
const FIT_MAX = 1.25;
const PAD = 16;

const LEVELS = ["context", "containers"] as const;
const DETAILS = ["boundaries", "systems"] as const;

const KIND_HUE: Record<DBox["node"]["kind"], string> = { person: "orange", group: "slate", external: "slate", system: "blue", container: "blue", focal: "blue" };

const nodeColor = (n: Node) => (n.type === "c4box" ? hue(KIND_HUE[(n.data as C4BoxData).box.node.kind]) : "transparent");
const nodeStroke = (n: Node) => (n.type === "c4box" && (n.data as C4BoxData).on ? "var(--accent)" : "transparent");

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
  const c = useCanvasModel(doc, template);
  const f = useStepFocus(c);
  const { step, edge, focus, hits, setSelection } = f;
  const canFold = useMemo(() => (graph ? foldable(graph) : false), [graph]);
  const [param, setParam] = useQueryParam("level");
  const level: Level = !compact && param === "containers" ? "containers" : "context";
  const pendingFit = useRef(true);
  const viewBox = useCallback(() => {
    const el = wrap.current;
    return el && el.clientWidth > 0 ? { width: el.clientWidth - 2 * PAD, height: el.clientHeight - 2 * PAD } : null;
  }, []);
  const { detail, setDetail, setOpen, diagram } = useC4Diagram(graph, level, canFold, viewBox, pendingFit);
  const [zoom, setZoom] = useState(1);
  const [ready, setReady] = useState(false);
  const centreOn = useRef<string | null>(null);

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

  const { walkTo, ...frameFocus } = focusChrome(f, { c, reveal, decision: props.decision, compact, focus: props.focus });

  const relayout = (next: () => void) => {
    pendingFit.current = true;
    next();
  };
  const foldGroup = useCallback((id: string) => {
    pendingFit.current = true;
    setOpen((prev) => new Set([...prev].filter((x) => x !== id)));
  }, [setOpen]);

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


  const nodes = useMemo(
    () => (diagram ? c4Nodes(diagram, { step, focus, hits, diff, health, onFold: compact ? null : foldGroup }) : []),
    [diagram, step, focus, hits, diff, compact, foldGroup, health],
  );

  const edges = useMemo(() => (diagram ? c4Edges(diagram, { focus, edge, graph }) : []), [diagram, focus, edge, graph]);

  const el = wrap.current;
  const overflowing = Boolean(diagram && el && (diagram.width * zoom > el.clientWidth - 8 || diagram.height * zoom > el.clientHeight - 8));

  const toolbar = (
    <C4Toolbar
      compact={compact}
      level={level}
      onLevel={(v) => setParam(v === "context" ? null : v)}
      detail={canFold ? detail : null}
      onDetail={(v) =>
        relayout(() => {
          setOpen(new Set());
          setDetail(v);
        })
      }
      onWalk={() => walkTo(0)}
      health={health}
      changes={props.changes}
      focus={props.focus}
    />
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
      zoom={zoom}
      minZoom={MIN_READABLE_ZOOM}
      maxZoom={MAX_ZOOM}
      onNodeClick={onNodeClick}
      onEdgePick={pickEdge}
      onMove={(vp) => setZoom(vp.zoom)}
      onFit={() => {
        if (diagram) fitTo(diagram);
      }}
      nodeColor={nodeColor}
      nodeStroke={nodeStroke}
      toolbar={toolbar}
      {...frameFocus}
      compact={compact}
      overflowing={overflowing}
    />
  );
}

type Focus = ReturnType<typeof useStepFocus>["focus"];

function c4Nodes(
  diagram: Diagram,
  o: {
    step: string | null;
    focus: Focus;
    hits: ReadonlySet<string>;
    diff: WorkflowCanvasProps["diff"];
    health: WorkflowCanvasProps["health"];
    onFold: ((id: string) => void) | null;
  },
): Node[] {
  const { step, focus, hits, diff, health } = o;
  const out: Node[] = diagram.frames.map((fr) => {
    const data: C4FrameData = { frame: fr, onFold: o.onFold };
    return { id: `frame:${fr.frame.id}`, type: "c4frame", position: { x: fr.x, y: fr.y }, width: fr.w, height: fr.h, data, zIndex: -1, draggable: false, selectable: false, focusable: false };
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
      canOpen: o.onFold !== null,
    };
    out.push({ id: x.node.id, type: "c4box", position: { x: x.x, y: x.y }, width: x.w, height: x.h, data, draggable: false, selectable: false });
  }
  return out;
}

function c4Edges(diagram: Diagram, o: { focus: Focus; edge: string | null; graph: SystemGraph | null }): Edge[] {
  const { focus, edge, graph } = o;
  return diagram.lines.map((l) => {
    const ids = l.edge.rels.map((r) => r.id);
    const lit = Boolean(focus && ids.some((e) => focus.edges.has(e)));
    const data: C4LineData = { line: l, rows: graph ? l.edge.rels.map((r) => relationshipText(r, graph)) : [], on: edge !== null && ids.includes(edge), lit, dim: Boolean(focus) && !lit };
    const head = { type: MarkerType.ArrowClosed, color: l.colour, width: 14, height: 14 };
    return { id: l.id, source: l.ends[0], target: l.ends[1], type: "c4", data, selectable: false, markerEnd: head, markerStart: head };
  });
}

function C4Toolbar({
  compact,
  level,
  onLevel,
  detail,
  onDetail,
  onWalk,
  health,
  changes,
  focus,
}: {
  compact: boolean;
  level: Level;
  onLevel: (v: Level) => void;
  /** Null when the view cannot fold, or before the fit has chosen. */
  detail: Detail | null;
  onDetail: (v: Detail) => void;
  onWalk: () => void;
  health: WorkflowCanvasProps["health"];
  changes: WorkflowCanvasProps["changes"];
  focus: WorkflowCanvasProps["focus"];
}) {
  const t = useCopy();
  return (
    <div className="wfc-float wfc-tl" role="toolbar" aria-label={t("workflows.canvas.view")} data-testid="c4-toolbar">
      {compact ? null : (
        <SegmentedControl<Level> options={LEVELS.map((v) => ({ value: v, label: t(`workflows.c4.level.${v}`), title: t(`workflows.c4.level.${v}.hint`) }))} value={level} onChange={onLevel} />
      )}
      {detail ? (
        <>
          {compact ? null : <span className="wfc-sep" />}
          <SegmentedControl<Detail> options={DETAILS.map((v) => ({ value: v, label: t(`workflows.c4.detail.${v}`), title: t(`workflows.c4.detail.${v}.hint`) }))} value={detail} onChange={onDetail} />
        </>
      ) : null}
      {compact ? null : (
        <>
          <span className="wfc-sep" />
          <Button type="button" variant="ghost" size="sm" className="wfc-ib" data-go="true" onClick={onWalk} title={t("workflows.c4.walkHint")} data-testid="walk-start-bar">
            <Play size={16} />
            <span className="wfc-t">{t("workflows.canvas.walk")}</span>
          </Button>
        </>
      )}
      {health ? <HealthBar health={health} /> : null}
      {compact ? null : <PageBar changes={changes} focus={focus} />}
    </div>
  );
}

/** The C4 pipeline from graph to laid-out diagram: the detail the fit chooses for a level, the boundaries the reader opened, and ELK's layout of that view. */
function useC4Diagram(
  graph: SystemGraph | null,
  level: Level,
  canFold: boolean,
  viewBox: () => { width: number; height: number } | null,
  pendingFit: { current: boolean },
) {
  /** Null until the fit has chosen it for this level. */
  const [detail, setDetail] = useState<Detail | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [diagram, setDiagram] = useState<Diagram | null>(null);

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

  return { detail, setDetail, setOpen, diagram };
}
