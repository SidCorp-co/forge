import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { KnowledgeIndex } from "@/lib/types";
import { buildGraph, type GraphLayout, type NodeObj } from "./graph-builder";
import { createNodeCanvasObject, createLinkCanvasObject } from "./graph-canvas-renderer";

export type { GraphLayout };

export function KnowledgeGraph({ index, width, height, layout = "force" }: { index: KnowledgeIndex; width: number; height: number; layout?: GraphLayout }) {
  const fgRef = useRef<any>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const graphData = useMemo(() => buildGraph(index, layout, width, height, collapsed), [index, layout, width, height, collapsed]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    if (layout === "radial" || layout === "mindmap") {
      fg.d3Force("charge", null);
      fg.d3Force("link", null);
      fg.d3Force("center", null);
      fg.d3ReheatSimulation();
      setTimeout(() => fg.zoomToFit(300, 40), 100);
    } else {
      const charge = fg.d3Force("charge");
      if (charge) charge.strength(-120).distanceMax(400);
      const link = fg.d3Force("link");
      if (link) link.distance((l: any) => {
        const target = l.target as any;
        return target?.type === "resource" ? 40 : 80;
      });
      fg.d3ReheatSimulation();
      setTimeout(() => fg.zoomToFit(300, 50), 1500);
    }
  }, [layout, collapsed]);

  const toggleCollapse = useCallback((domain: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(domain) ? next.delete(domain) : next.add(domain);
      return next;
    });
  }, []);

  const isMindmap = layout === "mindmap";
  const domains = index.domains ?? {};

  const nodeCanvasObject = useCallback(
    createNodeCanvasObject(layout, isMindmap, collapsed, domains),
    [layout, isMindmap, collapsed, domains],
  );

  const linkCanvasObject = useCallback(
    createLinkCanvasObject(isMindmap),
    [isMindmap],
  );

  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden bg-white">
      <ForceGraph2D
        ref={fgRef}
        key={`${layout}-${[...collapsed].join(",")}`}
        graphData={graphData}
        width={width}
        height={height}
        backgroundColor="#ffffff"
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={(node: any, color, ctx) => {
          const n = node as NodeObj;
          const hitR = n.type === "domain" ? 20 : n.type === "center" ? n.size : Math.max(n.size + 4, 10);
          ctx.beginPath();
          ctx.arc(node.x, node.y, hitR, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
        linkCanvasObject={linkCanvasObject}
        linkWidth={1}
        d3AlphaDecay={layout === "force" ? 0.03 : 0.1}
        d3VelocityDecay={layout === "force" ? 0.3 : 0.9}
        cooldownTicks={layout === "force" ? 100 : 0}
        enableNodeDrag={layout === "force"}
        nodeLabel={(node: any) => {
          const n = node as NodeObj;
          if (n.type === "domain") {
            const res = domains[n.label] ?? [];
            return `<b>${n.label}</b> (click to toggle)<br/>${res.join(", ")}`;
          }
          return n.label;
        }}
        onNodeClick={(node: any) => {
          const n = node as NodeObj;
          if (n.type === "domain") {
            toggleCollapse(n.label);
          } else if (fgRef.current) {
            fgRef.current.centerAt(node.x, node.y, 400);
            fgRef.current.zoom(3, 400);
          }
        }}
      />
    </div>
  );
}
