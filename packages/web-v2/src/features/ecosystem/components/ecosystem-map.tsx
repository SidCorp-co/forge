import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useEffect, useMemo, useState } from "react";
import { ProjectMark, statusReading, useMediaQuery } from "@/design";
import { type Placed, layoutGraph, rounded } from "@/lib/graph/layout";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { type Bus, projectMarkProps } from "../bus";
import type { Connection, ConnectionState } from "../connections";

/** A state's line and label colours, from the status tokens both themes define. */
const STATE_STATUS: Record<ConnectionState, "ok" | "warn" | "danger" | "muted"> = {
  current: "ok",
  behind: "warn",
  breaking: "danger",
  building: "muted",
  unverified: "muted",
  unfound: "muted",
};

interface BoxData extends Record<string, unknown> {
  slug: string;
  publishes: string[];
  vertical: boolean;
}

interface ArrowData extends Record<string, unknown> {
  d: string;
  label: string;
  at: { x: number; y: number } | null;
  status: (typeof STATE_STATUS)[ConnectionState];
  dashed: boolean;
}

// a browser reads a line's ends from the handles it finds in a node, so each node draws them, unseen and inert
const END = "pointer-events-none! opacity-0!";

function ProjectBox({ data }: NodeProps<Node<BoxData>>) {
  const t = useCopy();
  return (
    <div className="flex size-full min-w-0 flex-col justify-center gap-0.5 rounded-md border border-line-strong bg-surface px-3" data-testid="map-project">
      <Handle type="target" position={data.vertical ? Position.Top : Position.Left} isConnectable={false} className={END} />
      <span className="flex min-w-0 items-center gap-2 text-13 font-semibold text-fg">
        <ProjectMark {...projectMarkProps(data.slug)} size={18} />
        <span className="truncate">{data.slug}</span>
      </span>
      {data.publishes.length > 0 ? (
        <span className="break-words font-mono text-11 leading-4 text-muted">{t("ecosystem.map.publishes", { contracts: data.publishes.join(", ") })}</span>
      ) : null}
      <Handle type="source" position={data.vertical ? Position.Bottom : Position.Right} isConnectable={false} className={END} />
    </div>
  );
}

function Arrow({ id, data, markerEnd }: EdgeProps<Edge<ArrowData>>) {
  if (!data) return null;
  return (
    <>
      <BaseEdge
        id={id}
        path={data.d}
        markerEnd={markerEnd}
        style={{ stroke: `var(--status-${data.status}-solid)`, strokeWidth: 1.6, strokeDasharray: data.dashed ? "5 4" : undefined }}
      />
      {data.at ? (
        <EdgeLabelRenderer>
          <span
            className="pointer-events-none absolute max-w-50 rounded-sm border px-1.5 py-0.5 text-center text-11 font-medium leading-tight"
            data-testid="map-arrow-label"
            data-state={data.status}
            style={{
              transform: `translate(-50%, -50%) translate(${data.at.x}px, ${data.at.y}px)`,
              background: `var(--status-${data.status}-bg)`,
              borderColor: `var(--status-${data.status}-line)`,
              color: `var(--status-${data.status}-fg)`,
            }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const NODE_TYPES = { project: ProjectBox };
const EDGE_TYPES = { arrow: Arrow };

/** The words an arrow carries: the contract, the version in use and the state, never a colour alone. */
export function arrowLabel(c: Connection, t: Copy): string {
  const version = c.state === "unfound" ? (c.declared?.builtAgainst ?? "") : c.uses.join(", ");
  const state = c.state === "unfound" ? t("ecosystem.map.unfound") : statusReading("link", c.state).label.toLowerCase();
  return t("ecosystem.map.edge", { contract: c.contract.slug, version, state });
}

type Laid = { placed: Placed } | { failed: string };

function boxSize(slug: string, publishes: string[]) {
  // the slug beside its mark at 13px on one line; the published list in 11px mono wraps under it, so a
  // long list makes the box taller, never wider than the map can hold
  const width = Math.min(220, Math.max(140, 48 + slug.length * 8));
  const lines = publishes.length ? Math.ceil(((publishes.join(", ").length + 10) * 6.8) / (width - 26)) : 0;
  return { width, height: 40 + lines * 16 };
}

function MapDiagram({ bus, connections }: { bus: Bus; connections: readonly Connection[] }) {
  const t = useCopy();
  // a phone reads top to bottom: the same arrows, laid downward, so the map never scrolls sideways there
  const vertical = !useMediaQuery("(min-width: 40rem)");
  const boxes = useMemo(
    () =>
      bus.projects.map((p) => {
        const publishes = bus.contracts.filter((c) => c.provider === p.id).map((c) => c.slug);
        return { id: p.id, slug: p.slug, publishes, ...boxSize(p.slug, publishes) };
      }),
    [bus],
  );
  const arrows = useMemo(() => connections.map((c) => ({ c, label: arrowLabel(c, t) })), [connections, t]);
  const [laid, setLaid] = useState<Laid | null>(null);

  useEffect(() => {
    let live = true;
    layoutGraph({
      direction: vertical ? "down" : "right",
      partitioned: false,
      nodes: boxes.map(({ id, width, height }) => ({ id, width, height })),
      edges: arrows.map(({ c, label }) => ({ id: c.key, from: c.consumer, to: c.contract.provider, label })),
    }).then(
      (placed) => live && setLaid({ placed }),
      (err: unknown) => live && setLaid({ failed: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [boxes, arrows, vertical]);

  const flow = useMemo(() => {
    if (!laid || !("placed" in laid)) return null;
    const { placed } = laid;
    const nodes: Node<BoxData>[] = boxes.map((b) => {
      const p = placed.nodes.get(b.id) ?? { x: 0, y: 0, width: b.width, height: b.height };
      const [inAt, outAt] = vertical
        ? [{ x: p.width / 2, y: 0 }, { x: p.width / 2, y: p.height }]
        : [{ x: 0, y: p.height / 2 }, { x: p.width, y: p.height / 2 }];
      return {
        id: b.id,
        type: "project",
        position: { x: p.x, y: p.y },
        width: p.width,
        height: p.height,
        data: { slug: b.slug, publishes: b.publishes, vertical },
        draggable: false,
        selectable: false,
        handles: [
          { type: "target", position: vertical ? Position.Top : Position.Left, ...inAt, width: 1, height: 1 },
          { type: "source", position: vertical ? Position.Bottom : Position.Right, ...outAt, width: 1, height: 1 },
        ],
      };
    });
    const edges: Edge<ArrowData>[] = arrows.map(({ c, label }) => {
      const line = placed.edges.get(c.key);
      const status = STATE_STATUS[c.state];
      return {
        id: c.key,
        type: "arrow",
        source: c.consumer,
        target: c.contract.provider,
        markerEnd: { type: MarkerType.ArrowClosed, color: `var(--status-${status}-solid)`, width: 14, height: 14 },
        data: { d: line ? rounded(line.points) : "", label, at: line?.label ?? null, status, dashed: c.state === "unfound" },
        selectable: false,
      };
    });
    return { nodes, edges, width: Math.ceil(placed.width + 24), height: Math.max(80, Math.ceil(placed.height + 24)) };
  }, [laid, boxes, arrows, vertical]);

  if (laid && "failed" in laid) return <p className="text-13 text-muted">{t("ecosystem.map.failed")}</p>;
  if (!flow) return <p className="text-12 text-subtle">{t("ecosystem.map.laying")}</p>;
  return (
    <div className="max-h-130 overflow-auto" data-testid="map-scroll">
      <div style={{ height: flow.height, width: flow.width }} data-testid="map-canvas">
        <ReactFlow
          className="[&_.react-flow__pane]:touch-auto"
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          panOnDrag={false}
          preventScrolling={false}
          minZoom={1}
          maxZoom={1}
          fitView
          fitViewOptions={{ padding: 0, minZoom: 1, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        />
      </div>
    </div>
  );
}

/** Who uses what from whom: each project a box, each connection an arrow from consumer to provider, in words. */
export function EcosystemMap({ bus, connections }: { bus: Bus; connections: readonly Connection[] }) {
  const t = useCopy();
  return (
    <figure aria-label={t("ecosystem.map.label")} className="min-w-0" data-testid="ecosystem-map">
      <ReactFlowProvider>
        <MapDiagram bus={bus} connections={connections} />
      </ReactFlowProvider>
    </figure>
  );
}
