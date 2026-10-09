"use client";

import type { HealthMarkerKind } from "@forge/contracts/workflow-health";
import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";
import { SYSTEM_CONTEXT_TEMPLATE } from "@forge/contracts/system-graph";
import type { DesignDiff } from "../design-diff";
import type { HealthLayer, NodeHealthView } from "../health";
import type { SystemGraphRef, WorkflowBody } from "../types";
import { C4Canvas } from "./c4-canvas";
import { FlowCanvas } from "./flow-canvas";

/** The health overlay a page hands the canvas: whether it draws, which layer, and what sits on each node and line. */
export interface CanvasHealth {
  on: boolean;
  onToggle: (on: boolean) => void;
  layer: HealthLayer;
  onLayer: (layer: HealthLayer) => void;
  /** The code has been observed, so the layer switch applies. */
  observed: boolean;
  nodes: ReadonlyMap<string, NodeHealthView>;
  edges: ReadonlyMap<string, HealthMarkerKind[]>;
  /** Where a marker's source record opens. */
  hrefOf: (m: NodeHealthView["markers"][number]) => string | null;
}

/** Focus mode: the canvas alone, filling the viewport, with its toolbar, zoom, minimap and step panel. */
export interface CanvasFocus {
  on: boolean;
  onToggle: () => void;
}

/**
 * Steps and lines a page names to stand out with nothing clicked, the rest dimmed: a requirement's
 * page lights what its criteria trace (REQ-35 BC-3). Edges are named `from>to`, as the canvas keys
 * them. A selection made on the canvas still takes the light while it stands.
 */
export interface CanvasHighlight {
  steps: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

/** The switch that marks, on the canvas, what changed since the approved revision. */
export interface CanvasChanges {
  on: boolean;
  onToggle: (on: boolean) => void;
  label: string;
  title: string;
}

export interface WorkflowCanvasProps {
  doc: Pick<WorkflowBody, "title" | "summary" | "kind" | "steps" | "edges" | "flow" | "lanes" | "personas">;
  template: WorkflowTemplate | null;
  diff?: DesignDiff | null;
  /** The approver's Approve / Return, shown in the panel and at the end of a walk-through. */
  decision?: ReactNode;
  compact?: boolean;
  /** Where core reads a system context's graph; the C4 canvas draws nothing without it. */
  graph?: SystemGraphRef | null;
  health?: CanvasHealth | null;
  /** Absent on a compact pane: focus mode is the design page's. */
  focus?: CanvasFocus | null;
  changes?: CanvasChanges | null;
  highlight?: CanvasHighlight | null;
}

/**
 * A design on the one canvas (`Frame`), in its template's layout: C4 for a system context, bands and
 * steps for every other template.
 */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>{props.template?.id === SYSTEM_CONTEXT_TEMPLATE ? <C4Canvas {...props} /> : <FlowCanvas {...props} />}</ReactFlowProvider>
  );
}
