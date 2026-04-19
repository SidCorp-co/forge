'use client';

import { useMemo, useCallback, useRef, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { KnowledgeIndex } from '@/features/project/types';
import { buildGraph, type GraphLayout, type NodeObj } from './graph-builder';
import { createNodeCanvasObject, createLinkCanvasObject } from './graph-canvas-renderer';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d').then(m => m.default || m), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center h-[500px] text-sm text-outline">Loading graph...</div>,
});

export type { GraphLayout };

export function KnowledgeGraphView({ index, layout = 'force' }: { index: KnowledgeIndex; layout?: GraphLayout }) {
  const fgRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 600, h: 500 });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      // Cap height to remaining viewport space so graph doesn't overflow
      const rect = containerRef.current?.getBoundingClientRect();
      const maxH = rect ? Math.floor(window.innerHeight - rect.top - 32) : 600;
      if (w > 0) setDims({ w, h: Math.min(Math.max(400, Math.floor(w * 0.6)), maxH) });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const graphData = useMemo(
    () => buildGraph(index, layout, dims.w, dims.h, collapsed),
    [index, layout, dims.w, dims.h, collapsed],
  );

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    if (layout === 'radial' || layout === 'mindmap') {
      fg.d3Force('charge', null);
      fg.d3Force('link', null);
      fg.d3Force('center', null);
      fg.d3ReheatSimulation();
      setTimeout(() => fg.zoomToFit(300, 40), 100);
    } else {
      const charge = fg.d3Force('charge');
      if (charge) charge.strength(-120).distanceMax(400);
      const link = fg.d3Force('link');
      if (link) link.distance((l: any) => {
        const target = l.target as any;
        return target?.type === 'resource' ? 40 : 80;
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

  const isMindmap = layout === 'mindmap';
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
    <div ref={containerRef} className="rounded-lg border border-outline-variant/30 overflow-hidden bg-surface-container-low">
      <ForceGraph2D
        ref={fgRef}
        key={`${layout}-${[...collapsed].join(',')}`}
        graphData={graphData}
        width={dims.w}
        height={dims.h}
        backgroundColor="#ffffff"
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
          const n = node as NodeObj;
          const hitR = n.type === 'domain' ? 20 : n.type === 'center' ? n.size : Math.max(n.size + 4, 10);
          ctx.beginPath();
          ctx.arc(node.x, node.y, hitR, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
        linkCanvasObject={linkCanvasObject}
        linkWidth={1}
        d3AlphaDecay={layout === 'force' ? 0.03 : 0.1}
        d3VelocityDecay={layout === 'force' ? 0.3 : 0.9}
        cooldownTicks={layout === 'force' ? 100 : 0}
        enableNodeDrag={layout === 'force'}
        nodeLabel={(node: any) => {
          const n = node as NodeObj;
          if (n.type === 'domain') {
            const res = domains[n.label] ?? [];
            return `<b>${n.label}</b> (click to toggle)<br/>${res.join(', ')}`;
          }
          return n.label;
        }}
        onNodeClick={(node: any) => {
          const n = node as NodeObj;
          if (n.type === 'domain') {
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
