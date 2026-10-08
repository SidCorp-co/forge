"use client";

import type { VisualBlockOf } from "@forge/contracts/visual-blocks";
import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  type Node,
  type NodeProps,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useEffect, useMemo, useState } from "react";
import { type Placed, labelBox, layoutGraph, rounded } from "@/lib/graph/layout";
import { TextAlternative } from "./text-alternative";

interface StepData extends Record<string, unknown> {
  label: string;
}
interface LineData extends Record<string, unknown> {
  d: string;
  label: string | null;
  labelAt: { x: number; y: number } | null;
}

function Step({ data }: NodeProps<Node<StepData>>) {
  return (
    <div
      className="flex size-full items-center justify-center rounded-[6px] border border-line-strong bg-surface px-2 text-center text-[12px] leading-tight text-fg"
      data-testid="flow-node"
    >
      {data.label}
    </div>
  );
}

function Line({ id, data, markerEnd }: EdgeProps<Edge<LineData>>) {
  if (!data) return null;
  return (
    <>
      <BaseEdge id={id} path={data.d} markerEnd={markerEnd} style={{ stroke: "var(--fg-subtle)", strokeWidth: 1.4 }} />
      {data.label && data.labelAt && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute bg-app px-1 text-[11px] text-muted"
            data-testid="flow-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${data.labelAt.x}px, ${data.labelAt.y}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { step: Step };
const EDGE_TYPES = { line: Line };
const NODE_H_MIN = 36;

type Laid = { placed: Placed } | { failed: string } | null;

/** Boxes and lines, from the block's own nodes and edges, placed by the layered layout the workflow canvas uses. */
function FlowDiagram({ block }: { block: VisualBlockOf<"flow"> }) {
  const sizes = useMemo(
    () => new Map(block.nodes.map((n) => [n.id, { width: Math.max(96, labelBox(n.label).width + 16), height: Math.max(NODE_H_MIN, labelBox(n.label).height + 14) }])),
    [block],
  );
  const [laid, setLaid] = useState<Laid>(null);

  useEffect(() => {
    let live = true;
    setLaid(null);
    layoutGraph({
      direction: "down",
      partitioned: false,
      nodes: block.nodes.map((n) => ({ id: n.id, ...(sizes.get(n.id) as { width: number; height: number }) })),
      edges: block.edges.map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) })),
    }).then(
      (placed) => live && setLaid({ placed }),
      (err: unknown) => live && setLaid({ failed: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [block, sizes]);

  const flow = useMemo(() => {
    if (!laid || !("placed" in laid)) return null;
    const { placed } = laid;
    const nodes: Node<StepData>[] = block.nodes.map((n) => {
      const p = placed.nodes.get(n.id) ?? { x: 0, y: 0, ...(sizes.get(n.id) as { width: number; height: number }) };
      return {
        id: n.id,
        type: "step",
        position: { x: p.x, y: p.y },
        width: p.width,
        height: p.height,
        data: { label: n.label },
        draggable: false,
        selectable: false,
        // measured here, as the browser would: an edge needs its ends before any layout pass of the DOM
        handles: [
          { type: "target", position: Position.Top, x: p.width / 2, y: 0, width: 1, height: 1 },
          { type: "source", position: Position.Bottom, x: p.width / 2, y: p.height, width: 1, height: 1 },
        ],
      };
    });
    const edges: Edge<LineData>[] = block.edges.map((e, i) => {
      const line = placed.edges.get(`e${i}`);
      return {
        id: `e${i}`,
        type: "line",
        source: e.from,
        target: e.to,
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--fg-subtle)", width: 14, height: 14 },
        data: { d: line ? rounded(line.points) : "", label: e.label ?? null, labelAt: line?.label ?? null },
        selectable: false,
      };
    });
    return { nodes, edges, height: Math.min(520, Math.max(120, placed.height + 24)) };
  }, [laid, block, sizes]);

  if (laid && "failed" in laid) {
    return (
      <p className="text-[12.5px] text-muted" data-testid="flow-failed">
        This diagram could not be laid out, so its steps and links are listed below as text.
      </p>
    );
  }
  if (!flow) return <p className="text-[12px] text-subtle">Laying out the diagram.</p>;
  return (
    <div style={{ height: flow.height }} className="w-full" data-testid="flow-canvas">
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        minZoom={0.2}
        maxZoom={1.5}
        fitView
        fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  );
}

/** A flow block: the nodes and edges the answer names, drawn as a diagram. It holds no figure. */
export function FlowBlockView({ block }: { block: VisualBlockOf<"flow"> }) {
  return (
    <div data-testid="flow-block">
      <div aria-hidden>
        <ReactFlowProvider>
          <FlowDiagram block={block} />
        </ReactFlowProvider>
      </div>
      <TextAlternative block={block} />
    </div>
  );
}
