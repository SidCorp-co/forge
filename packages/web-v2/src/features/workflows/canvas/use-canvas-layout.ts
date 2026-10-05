"use client";

import { type Edge, MarkerType, type Node, useNodesInitialized, useNodesState, useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesignDiff } from "../design-diff";
import { edgeKey } from "../design-diff";
import { isObservedId } from "../health";
import type { CanvasHealth } from "./workflow-canvas";
import type { WfEdgeData } from "./edges";
import { layoutView, type Placed, returnPath, rounded } from "./layout";
import { type Canvas, bandSummary, lineLabel } from "./model";
import type { BandNodeData, BandRowData, StepNodeData } from "./nodes";
import { edgeHue } from "./style";
import { mergedLabel, type View } from "./view";

const GUT = 150;
const TOP = 44;

/** What the eye is on, kept at the same place on screen across a relayout. */
interface Anchor {
  ids: string[];
  sx: number;
  sy: number;
}

interface Decoration {
  selected: string | null;
  selectedEdge: string | null;
  relNodes: Set<string> | null;
  relEdges: Set<string> | null;
  hits: Set<string>;
  visited: Set<string>;
  contract: boolean;
  diff: DesignDiff | null;
  health: CanvasHealth | null;
}

function stepData(c: Canvas, n: View["nodes"][number], d: Decoration): StepNodeData | BandNodeData {
  if (n.kind === "band") {
    const band = c.bands.find((b) => b.id === n.band);
    const steps = band?.steps ?? [];
    return {
      label: band?.label ?? n.band,
      summary: band ? bandSummary(c, band) : { count: 0, types: [], owners: 0, deadlines: 0 },
      hits: steps.filter((id) => d.hits.has(id)).length,
      rel: !d.relNodes || steps.some((id) => d.relNodes?.has(id)),
    };
  }
  const step = c.steps.get(n.id);
  if (!step) throw new Error(`canvas: view names step ${n.id}, which the design does not hold`);
  return {
    step,
    type: c.typeOf(n.id),
    lane: c.laneOf(n.id),
    full: n.full,
    contract: d.contract,
    on: d.selected === n.id,
    rel: !d.relNodes || d.relNodes.has(n.id),
    hit: d.hits.has(n.id),
    visited: d.visited.has(n.id),
    mark: d.diff?.steps.get(n.id) ?? null,
    health: d.health?.on ? (d.health.nodes.get(n.id) ?? null) : null,
    hrefOf: d.health?.hrefOf ?? null,
    provenance: d.health?.observed ? (d.health.nodes.get(n.id)?.provenance ?? (isObservedId(n.id) ? "observed" : "matched")) : null,
  };
}

/**
 * The canvas's nodes and edges: the view's cards, measured by React Flow, laid out by ELK, with band
 * rows behind them and return lines drawn round the right of the graph.
 */
export function useCanvasLayout(input: {
  c: Canvas;
  view: View;
  structure: string;
  decoration: Decoration;
  direction: "down" | "right";
  onToggleBand: (band: string) => void;
  openBands: ReadonlySet<string>;
  /** Called once each layout lands; `first` for the very first one, which sets the opening view. */
  onLaidOut: (first: boolean, size: { width: number; height: number }) => void;
}) {
  const { c, view, structure, decoration, direction } = input;
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const initialized = useNodesInitialized();
  const [placed, setPlaced] = useState<{ structure: string; at: Placed; positions: Map<string, { x: number; y: number; width: number; height: number }>; width: number } | null>(null);
  const pending = useRef<string | null>(null);
  const anchor = useRef<Anchor | null>(null);
  const centerOn = useRef<string | null>(null);
  const first = useRef(true);
  const toggle = useRef(input.onToggleBand);
  toggle.current = input.onToggleBand;
  const laidOut = useRef(input.onLaidOut);
  laidOut.current = input.onLaidOut;

  // The structure and decoration effects each fire on their own trigger and read the rest as it is now.
  const latest = useRef({ c, view, decoration });
  latest.current = { c, view, decoration };

  useEffect(() => {
    if (!structure) return;
    const now = latest.current;
    pending.current = structure;
    setNodes((prev) => {
      const at = new Map(prev.map((n) => [n.id, n.position]));
      return now.view.nodes.map((n) => ({
        id: n.key,
        type: n.kind,
        position: at.get(n.key) ?? { x: 0, y: 0 },
        data: stepData(now.c, n, now.decoration),
        draggable: false,
        selectable: false,
      }));
    });
  }, [structure, setNodes]);

  useEffect(() => {
    const now = latest.current;
    setNodes((prev) =>
      prev.map((n) => {
        if (n.type === "bandRow") return n;
        const v = now.view.nodes.find((x) => x.key === n.id);
        return v ? { ...n, data: stepData(now.c, v, decoration) } : n;
      }),
    );
  }, [decoration, setNodes]);

  const anchorFor = useCallback(
    (ids: string[]): Anchor | null => {
      const vp = rf.getViewport();
      const keys = [...new Set(ids.map((id) => view.keyOf.get(id) ?? id))];
      const ns = keys.map((k) => rf.getNode(k)).filter((n): n is Node => Boolean(n));
      if (ns.length === 0) return null;
      const n = ns[0] as Node;
      return { ids, sx: (n.position.x + (n.measured?.width ?? 250) / 2) * vp.zoom + vp.x, sy: n.position.y * vp.zoom + vp.y };
    },
    [rf, view],
  );

  useEffect(() => {
    if (!initialized || pending.current !== structure) return;
    const token = structure;
    const sizes = new Map(
      rf.getNodes().filter((n) => n.type !== "bandRow").map((n) => [n.id, { width: n.measured?.width ?? 250, height: n.measured?.height ?? 60 }]),
    );
    const labels = new Map(
      view.edges.map((e) => [e.key, e.merged ? mergedLabel(e, c).text : e.src[0] ? lineLabel(e.src[0]).text : ""]),
    );
    const order = new Map(c.bands.map((b, i) => [b.id, i]));
    const bandOfKey = (key: string) => {
      const v = view.nodes.find((n) => n.key === key);
      return v?.kind === "band" ? v.band : v?.kind === "step" ? v.band : null;
    };
    const banded = c.bands.length > 0;
    void layoutView({
      view,
      sizes,
      labels,
      partition: banded ? (key) => order.get(bandOfKey(key) ?? "") ?? 0 : null,
      direction,
    }).then((at) => {
      if (pending.current !== token) return;
      pending.current = null;
      const left = banded ? GUT : 24;
      const positions = new Map([...at.nodes].map(([k, p]) => [k, { ...p, x: p.x + left, y: p.y + TOP }]));
      const width = Math.max(at.width + left + 150, 720);
      const height = at.height + TOP + 36;
      const rows: Node[] = [];
      if (banded) {
        const ext = new Map<string, { a: number; z: number }>();
        for (const [k, p] of positions) {
          const b = bandOfKey(k);
          if (!b) continue;
          const e = ext.get(b) ?? { a: Number.POSITIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
          ext.set(b, { a: Math.min(e.a, p.y), z: Math.max(e.z, p.y + p.height) });
        }
        const shown = c.bands.filter((b) => ext.has(b.id));
        shown.forEach((b, i) => {
          const e = ext.get(b.id) as { a: number; z: number };
          const prev = shown[i - 1];
          const next = shown[i + 1];
          const top = prev ? ((ext.get(prev.id)?.z ?? e.a) + e.a) / 2 : 0;
          const bottom = next ? (e.z + (ext.get(next.id)?.a ?? e.z)) / 2 : height;
          const colour = c.typeOf(b.steps[0] ?? "").colour;
          const data: BandRowData = {
            label: b.label,
            tooltip: b.tooltip,
            colour,
            odd: i % 2 === 1,
            open: input.openBands.has(b.id),
            onToggle: () => toggle.current(b.id),
          };
          rows.push({
            id: `row:${b.id}`,
            type: "bandRow",
            position: { x: 0, y: top },
            data,
            style: { width, height: bottom - top },
            zIndex: -1,
            draggable: false,
            selectable: false,
            focusable: false,
          });
        });
      }
      setNodes((prev) => [
        ...rows,
        ...prev.filter((n) => n.type !== "bandRow").map((n) => {
          const p = positions.get(n.id);
          return p ? { ...n, position: { x: p.x, y: p.y } } : n;
        }),
      ]);
      setPlaced({ structure: token, at, positions, width });
      const vp = rf.getViewport();
      const a = anchor.current;
      anchor.current = null;
      laidOut.current(first.current, { width, height });
      first.current = false;
      if (a) {
        const keys = [...new Set(a.ids.map((id) => view.keyOf.get(id) ?? id))];
        const ps = keys.map((k) => positions.get(k)).filter((p): p is NonNullable<typeof p> => Boolean(p));
        if (ps.length) {
          const x0 = Math.min(...ps.map((p) => p.x));
          const x1 = Math.max(...ps.map((p) => p.x + p.width));
          const y0 = Math.min(...ps.map((p) => p.y));
          void rf.setViewport({ x: a.sx - ((x0 + x1) / 2) * vp.zoom, y: a.sy - y0 * vp.zoom, zoom: vp.zoom });
        }
      }
      const focus = centerOn.current;
      centerOn.current = null;
      const p = focus ? positions.get(view.keyOf.get(focus) ?? focus) : null;
      if (p) void rf.setCenter(p.x + p.width / 2, p.y + p.height / 2, { zoom: vp.zoom, duration: 320 });
    });
  }, [initialized, structure, rf, view, c, direction, setNodes, input.openBands]);

  const edges = useMemo((): Edge[] => {
    if (!placed || placed.structure !== structure) return [];
    const { at, positions, width } = placed;
    const d = decoration;
    const left = c.bands.length > 0 ? GUT : 24;
    let returns = 0;
    return view.edges.flatMap((e): Edge[] => {
      const first = e.src[0];
      if (!first) return [];
      const isReturn = first.kind.direction === "return";
      const lit = Boolean(d.relEdges && e.src.some((s) => d.relEdges?.has(s.id)));
      const mark = e.merged ? null : (d.diff?.edges.get(edgeKey(first.from, first.to)) ?? d.diff?.steps.get(first.to) ?? null);
      let path: string;
      let labelAt: { x: number; y: number } | null;
      if (isReturn) {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return [];
        const r = returnPath(a, b, width - 80 + 14 * returns++);
        path = r.d;
        labelAt = r.label;
      } else {
        const routed = at.edges.get(e.key);
        if (!routed || routed.points.length < 2) return [];
        path = rounded(routed.points.map((p) => ({ x: p.x + left, y: p.y + TOP })));
        labelAt = routed.label ? { x: routed.label.x + left, y: routed.label.y + TOP } : null;
      }
      const k = first.contract;
      const data: WfEdgeData = {
        d: path,
        kind: first.kind,
        label: e.merged ? mergedLabel(e, c).text : lineLabel(first).text,
        full: e.merged ? mergedLabel(e, c).full : lineLabel(first).full,
        detail: d.contract && !e.merged && k ? [k.action, k.idempotency ? `idem: ${k.idempotency}` : null].filter(Boolean).join(" · ") || null : null,
        labelAt,
        merged: e.merged,
        isReturn,
        lit,
        dim: Boolean(d.relEdges) && !lit,
        on: d.selectedEdge === e.key,
        mark,
        health: e.merged || !d.health?.on ? [] : (d.health.edges.get(edgeKey(first.from, first.to)) ?? []),
      };
      return [
        {
          id: e.key,
          source: e.from,
          target: e.to,
          type: "wf",
          data,
          selectable: false,
          markerEnd: { type: MarkerType.ArrowClosed, color: edgeHue(first.kind), width: 14, height: 14 },
        },
      ];
    });
  }, [placed, structure, view, decoration, c]);

  return {
    nodes,
    edges,
    onNodesChange,
    ready: placed !== null,
    positions: placed?.positions ?? null,
    /** Keep what the eye is on in place across the next relayout. */
    keep: (a: Anchor | null) => {
      anchor.current = a;
    },
    /** Centre on this step once the next relayout lands; with none coming, now. */
    center: (id: string, relayout: boolean) => {
      if (relayout) {
        centerOn.current = id;
        return;
      }
      const p = placed?.positions.get(view.keyOf.get(id) ?? id);
      if (p) void rf.setCenter(p.x + p.width / 2, p.y + p.height / 2, { zoom: rf.getViewport().zoom, duration: 320 });
    },
    anchorFor,
  };
}
