"use client";

// One level of the module tree as a map on the workflow canvas's React Flow and ELK layout: a card per
// module in rollup order, wrapped into rows the width allows, and the couplings core rolled up to this
// level between them. Line width is the coupling's weight. The map is a fitted picture: nothing on it moves, pans or zooms.

import "@xyflow/react/dist/base.css";
import "@/features/workflows/canvas/canvas.css";
import { BaseEdge, type Edge, type EdgeProps, EdgeLabelRenderer, Handle, type Node, type NodeProps, Position, ReactFlow } from "@xyflow/react";
import { type KeyboardEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { layoutGraph, type Placed, rounded } from "@/features/workflows/canvas/layout";
import type { ModuleLevelCoupling, ModuleRollupRow } from "../types";

const MAX_COLS = 4;
const W = 214;
const H = 84;
/** One column of the packed rows: a card, ELK's padding round it and the gap to the next. */
const COL = W + 24 + 20;
const PAD = 8;

const keyOf = (r: ModuleRollupRow) => r.slug ?? r.id;

interface ModuleNodeData extends Record<string, unknown> {
  row: ModuleRollupRow;
  on: boolean;
  rel: boolean;
  act: { select: (key: string) => void; open: (key: string) => void };
}

interface CouplingEdgeData extends Record<string, unknown> {
  d: string;
  width: number;
  label: string;
  labelAt: { x: number; y: number } | null;
  title: string;
  dim: boolean;
}

function ModuleCard({ data }: NodeProps & { data: ModuleNodeData }) {
  const { row: r, act } = data;
  const key = keyOf(r);
  const s = r.standing;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") act.open(key);
    else if (e.key === " ") {
      e.preventDefault();
      act.select(key);
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${r.name}: ${s.childCount} child modules, ${s.open} open issues. Enter opens it.`}
      aria-pressed={data.on}
      className="wfc-card"
      style={{ width: W, height: H, ["--tc" as string]: data.on ? "var(--link)" : "var(--wf-slate)" }}
      data-on={data.on}
      data-rel={data.rel}
      data-testid="module-map-node"
      data-key={key}
      onClick={() => act.select(key)}
      onDoubleClick={() => act.open(key)}
      onKeyDown={onKey}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
      <h3 className="truncate">{r.name}</h3>
      <p>{s.childCount ? `${s.childCount} child modules` : "No child modules"}</p>
      <p>
        Open {s.open} · Requirements {s.requirements.length}
      </p>
    </div>
  );
}

function CouplingEdge({ id, data }: EdgeProps & { data: CouplingEdgeData }) {
  return (
    <>
      <BaseEdge
        id={id}
        path={data.d}
        interactionWidth={0}
        style={{ stroke: "var(--wf-edge)", strokeWidth: data.width, strokeLinecap: "round", opacity: data.dim ? 0.1 : 0.75 }}
        data-testid="module-map-edge"
      />
      {data.labelAt ? (
        <EdgeLabelRenderer>
          <div
            className="wfc-label nodrag nopan font-mono tabular-nums"
            data-rel={!data.dim}
            title={data.title}
            style={{ transform: `translate(-50%, -50%) translate(${data.labelAt.x}px, ${data.labelAt.y}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const NODE_TYPES = { module: memo(ModuleCard) };
const EDGE_TYPES = { coupling: memo(CouplingEdge) };

function edgeTitle(c: ModuleLevelCoupling, name: (id: string) => string): string {
  const a = name(c.aId);
  const b = name(c.bId);
  return `${a} and ${b}: ${c.sharedIssues} issues carry both sides`;
}

const edgeLabel = (c: ModuleLevelCoupling) => String(c.weight);

/** The map's width as it changes, measured from the element itself. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e ? e.contentRect.width : 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function ModuleMap({
  rows,
  couplings,
  selected,
  onSelect,
  onOpen,
}: {
  rows: readonly ModuleRollupRow[];
  couplings: readonly ModuleLevelCoupling[];
  selected: string | null;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
}) {
  const [wrap, width] = useWidth();
  const cols = Math.max(1, Math.min(MAX_COLS, rows.length, Math.floor((width - 2 * PAD + 20) / COL)));
  const ids = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  // A coupling is drawn only between two modules on this level; nothing is drawn that core did not roll up.
  const drawn = useMemo(() => couplings.filter((c) => ids.has(c.aId) && ids.has(c.bId)), [couplings, ids]);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const measured = width > 0;

  useEffect(() => {
    if (!measured) return;
    let live = true;
    void layoutGraph({
      direction: "down",
      partitioned: false,
      rowWidth: cols * COL - 20 + 4,
      nodes: rows.map((r) => ({ id: r.id, width: W, height: H })),
      edges: drawn.map((c) => ({ id: `${c.aId}-${c.bId}`, from: c.aId, to: c.bId, label: edgeLabel(c) })),
    }).then((at) => {
      if (live) setPlaced(at);
    });
    return () => {
      live = false;
    };
  }, [rows, drawn, cols, measured]);

  const act = useRef({ select: onSelect, open: onOpen });
  act.current = { select: onSelect, open: onOpen };
  const stableAct = useMemo(() => ({ select: (k: string) => act.current.select(k), open: (k: string) => act.current.open(k) }), []);

  const selectedId = rows.find((r) => keyOf(r) === selected)?.id ?? null;
  const near = useMemo(
    () => new Set(selectedId ? drawn.flatMap((c) => (c.aId === selectedId || c.bId === selectedId ? [c.aId, c.bId] : [])) : []),
    [drawn, selectedId],
  );

  const nodes = useMemo((): Node[] => {
    if (!placed) return [];
    return rows.flatMap((r) => {
      const p = placed.nodes.get(r.id);
      if (!p) return [];
      const data: ModuleNodeData = { row: r, on: r.id === selectedId, rel: !selectedId || r.id === selectedId || near.has(r.id), act: stableAct };
      return [{ id: r.id, type: "module", position: { x: p.x, y: p.y }, width: W, height: H, data, draggable: false, selectable: false, focusable: false }];
    });
  }, [placed, rows, selectedId, near, stableAct]);

  const edges = useMemo((): Edge[] => {
    if (!placed) return [];
    const max = Math.max(1, ...drawn.map((c) => c.weight));
    const name = (id: string) => rows.find((r) => r.id === id)?.name ?? id;
    return drawn.flatMap((c) => {
      const id = `${c.aId}-${c.bId}`;
      const routed = placed.edges.get(id);
      if (!routed || routed.points.length < 2) return [];
      const data: CouplingEdgeData = {
        d: rounded(routed.points),
        width: 1 + 5 * Math.sqrt(c.weight / max),
        label: edgeLabel(c),
        labelAt: routed.label,
        title: edgeTitle(c, name),
        dim: selectedId !== null && c.aId !== selectedId && c.bId !== selectedId,
      };
      return [{ id, source: c.aId, target: c.bId, type: "coupling", data, selectable: false, focusable: false }];
    });
  }, [placed, drawn, rows, selectedId]);

  // Fit: as large as the width holds, never above 100%; the map is as tall as the fitted drawing.
  const at = placed;
  const zoom = at && width > 0 ? Math.min(1, (width - 2 * PAD) / Math.max(1, at.width)) : 1;
  const height = at ? at.height * zoom + 2 * PAD : Math.ceil(rows.length / cols) * (H + 44) + 2 * PAD;
  const viewport = { x: at ? (width - at.width * zoom) / 2 : PAD, y: PAD, zoom };

  return (
    <div
      ref={wrap}
      role="group"
      aria-label={`Map of ${rows.length} modules and ${drawn.length} couplings between them`}
      className="wfc"
      style={{ height, minHeight: 0 }}
      data-ready={placed !== null}
      data-dim={selectedId !== null}
      data-static="true"
      data-testid="module-map"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        viewport={viewport}
        minZoom={0.1}
        maxZoom={1}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        disableKeyboardA11y
        proOptions={{ hideAttribution: true }}
      />
    </div>
  );
}
