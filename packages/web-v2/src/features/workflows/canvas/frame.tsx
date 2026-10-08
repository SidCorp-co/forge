"use client";

import "@xyflow/react/dist/base.css";
import "./canvas.css";
import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { type Edge, type EdgeTypes, MiniMap, type Node, type NodeTypes, type OnNodesChange, ReactFlow, useReactFlow, type Viewport } from "@xyflow/react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Legend, ZoomBar } from "./controls";
import type { CanvasFocus } from "./workflow-canvas";

const wide = () => typeof window === "undefined" || window.innerWidth > 700;

interface FrameProps {
  /** Which layout drew the nodes: the design's own (ELK, by template) or a C4 level. */
  layout: "flow" | "c4-context" | "c4-containers";
  wrap: RefObject<HTMLDivElement | null>;
  template: WorkflowTemplate | null;
  nodes: Node[];
  edges: Edge[];
  onNodesChange?: OnNodesChange;
  nodeTypes: NodeTypes;
  edgeTypes: EdgeTypes;
  ready: boolean;
  /** Something is selected, so what is not related to it is dimmed. */
  dim: boolean;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  onNodeClick: (n: Node) => void;
  onEdgePick: (key: string) => void;
  onPaneClick: () => void;
  onMove: (vp: Viewport) => void;
  onFit: () => void;
  /** Zoom by a factor; absent, zoom within the bounds. */
  onZoom?: (factor: number) => void;
  /** Escape: true when it ended a walk or cleared a selection, so focus mode is left only by the next one. */
  onEscape: () => boolean;
  onArrow?: (dir: -1 | 1) => void;
  nodeColor: (n: Node) => string;
  nodeStroke: (n: Node) => string;
  /** The top-left bar: what the layout lets the viewer change. */
  toolbar: ReactNode;
  search: ReactNode;
  walkBar: ReactNode;
  panel: ReactNode;
  /** A pane on another page (the Workflows overview): no keyboard shortcuts of its own, no side panel. */
  compact?: boolean;
  /** The drawing is larger than the view. */
  overflowing?: boolean;
  /** Focus mode, where the page offers it: F enters or leaves it, Shift+F fits, Escape leaves it. */
  focus?: CanvasFocus | null | undefined;
}

/**
 * The one canvas every design is drawn on: React Flow with the minimap, the zoom bar, the legend, the
 * toolbar, the search, the walk-through bar and the side panel. A layout supplies the nodes, the edges
 * and what a click, a move or a fit means; nothing here knows which layout it is drawing.
 */
export function Frame(p: FrameProps) {
  const rf = useReactFlow();
  // A full canvas opens with its minimap on a wide screen; a compact pane shows it only while the
  // drawing is larger than the view, since at fit it would sit on the drawing it maps.
  const [minimapPick, setMinimapPick] = useState<boolean | null>(() => (p.compact ? null : wide()));
  const minimap = minimapPick ?? Boolean(p.overflowing);
  const [legend, setLegend] = useState(false);

  useEffect(() => {
    if (p.compact) return;
    const onKey = (ev: KeyboardEvent) => {
      const typing = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement || (ev.target instanceof HTMLElement && ev.target.isContentEditable);
      if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const focus = p.focus;
      if (ev.key === "/") {
        ev.preventDefault();
        p.wrap.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus();
      } else if (ev.key === "ArrowRight") p.onArrow?.(1);
      else if (ev.key === "ArrowLeft") p.onArrow?.(-1);
      else if (ev.key === "Escape") {
        if (!p.onEscape() && focus?.on) focus.onToggle();
      } else if (ev.key === "f" || ev.key === "F") {
        if (focus && !ev.shiftKey) focus.onToggle();
        else p.onFit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const zoomBy = p.onZoom ?? ((f: number) => void rf.zoomTo(Math.min(p.maxZoom, Math.max(p.minZoom, rf.getZoom() * f)), { duration: 160 }));

  // Side by side, the row takes the screen's height rather than the panel's: `contain: size` keeps the
  // panel's 16 steps from stretching it, so the panel scrolls and the canvas fills the screen.
  return (
    <div className={cn("flex min-h-0 flex-1", !p.compact && "max-lg:flex-col lg:[contain:size]")} data-testid="workflow-canvas" data-layout={p.layout} data-focus={Boolean(p.focus?.on)}>
      <div
        ref={p.wrap}
        className={cn("wfc min-w-0 flex-1", !p.compact && !p.focus?.on && "max-lg:h-[72vh] max-lg:flex-none")}
        data-ready={p.ready}
        data-dim={p.dim}
        data-compact={Boolean(p.compact)}
        onClickCapture={(ev) => {
          const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-edge]");
          if (t?.dataset.edge) p.onEdgePick(t.dataset.edge);
        }}
      >
        <ReactFlow
          nodes={p.nodes}
          edges={p.edges}
          onNodesChange={p.onNodesChange}
          nodeTypes={p.nodeTypes}
          edgeTypes={p.edgeTypes}
          onNodeClick={(_, n) => p.onNodeClick(n)}
          onEdgeClick={(_, e) => p.onEdgePick(e.id)}
          onPaneClick={p.onPaneClick}
          onMove={(_, vp) => p.onMove(vp)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          minZoom={p.minZoom}
          maxZoom={p.maxZoom}
          proOptions={{ hideAttribution: true }}
        >
          {minimap ? (
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              style={{ width: 180, height: 120 }}
              nodeColor={p.nodeColor}
              nodeStrokeColor={p.nodeStroke}
              nodeStrokeWidth={6}
              nodeBorderRadius={14}
              maskColor="color-mix(in srgb, var(--accent) 6%, transparent)"
            />
          ) : null}
        </ReactFlow>
        {p.toolbar}
        {p.search}
        <ZoomBar
          zoom={p.zoom}
          minimap={minimap}
          legend={legend}
          onZoom={zoomBy}
          onReset={() => void rf.zoomTo(Math.max(p.minZoom, 1), { duration: 160 })}
          onFit={p.onFit}
          onMinimap={() => setMinimapPick(!minimap)}
          onLegend={() => setLegend(!legend)}
        />
        {legend ? <Legend template={p.template} /> : null}
        {p.walkBar}
      </div>
      {p.panel}
    </div>
  );
}
