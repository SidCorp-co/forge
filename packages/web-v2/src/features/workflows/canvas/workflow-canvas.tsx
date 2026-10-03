"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";
import { SYSTEM_CONTEXT_TEMPLATE } from "../c4/model";
import type { DesignDiff } from "../design-diff";
import type { WorkflowBody } from "../types";
import { C4Canvas } from "./c4-canvas";
import { FlowCanvas } from "./flow-canvas";

export interface WorkflowCanvasProps {
  doc: Pick<WorkflowBody, "title" | "summary" | "kind" | "steps" | "edges" | "flow" | "lanes" | "personas">;
  template: WorkflowTemplate | null;
  diff?: DesignDiff | null;
  /** The approver's Approve / Return, shown in the panel and at the end of a walk-through. */
  decision?: ReactNode;
  compact?: boolean;
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
