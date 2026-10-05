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
