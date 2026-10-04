"use client";

import type { TemplateEdgeKind } from "@forge/contracts/workflow-templates";
import { BaseEdge, type EdgeProps, EdgeLabelRenderer } from "@xyflow/react";
import { memo } from "react";
import type { StepMark } from "../design-diff";
import { DASH, edgeHue, MARK_HUE } from "./style";

export interface WfEdgeData extends Record<string, unknown> {
  d: string;
  kind: TemplateEdgeKind;
  label: string;
  /** The untrimmed condition when `label` cuts it short or names it in other words; on a merged line, every line it stands for. */
  full: string | null;
  /** The contract line shown under the label in the Contract view. */
  detail: string | null;
  labelAt: { x: number; y: number } | null;
  merged: boolean;
  isReturn: boolean;
  lit: boolean;
  dim: boolean;
  on: boolean;
  mark: StepMark | null;
}

function WfEdge({ id, data, markerEnd }: EdgeProps & { data: WfEdgeData }) {
  const stroke = data.mark && data.mark !== "changed" ? MARK_HUE[data.mark] : edgeHue(data.kind);
  return (
    <>
      <BaseEdge
        id={id}
        path={data.d}
        markerEnd={markerEnd}
        interactionWidth={14}
        style={{
          stroke,
          strokeWidth: data.lit ? 2.4 : data.isReturn ? 2 : 1.6,
          strokeDasharray: DASH[data.kind.line],
          opacity: data.dim ? 0.15 : data.kind.line === "solid" ? 1 : 0.8,
        }}
      />
      {data.labelAt && (data.label || data.detail) ? (
        <EdgeLabelRenderer>
          <div
            className="wfc-label nodrag nopan"
            data-edge={id}
            data-merged={data.merged}
            data-return={data.isReturn}
            data-on={data.on}
            data-rel={!data.dim}
            title={data.merged ? `${data.full ?? ""}\nClick to open both stages` : (data.full ?? data.kind.tooltip)}
            style={{
              ["--tc" as string]: edgeHue(data.kind),
              transform: `translate(-50%, -50%) translate(${data.labelAt.x}px, ${data.labelAt.y}px)`,
            }}
          >
            {data.isReturn ? `↺ ${data.label || data.kind.label}` : data.label}
            {data.detail ? <span className="wfc-mono">{data.detail}</span> : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const EDGE_TYPES = { wf: memo(WfEdge) };
