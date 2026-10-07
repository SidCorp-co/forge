"use client";

import type { HealthMarkerKind } from "@forge/contracts/workflow-health";
import type { TemplateEdgeKind } from "@forge/contracts/workflow-templates";
import { BaseEdge, type EdgeProps, EdgeLabelRenderer } from "@xyflow/react";
import { memo } from "react";
import { HealthMark } from "../components/health-parts";
import type { StepMark } from "../design-diff";
import { DASH, edgeHue, MARK_HUE } from "./style";
import { useCopy } from "@/lib/i18n/interface-language";

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
  /** The line's marker kinds while the Health overlay is on. */
  health: HealthMarkerKind[];
}

function WfEdge({ id, data, markerEnd }: EdgeProps & { data: WfEdgeData }) {
  const t = useCopy();
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
      {data.labelAt && (data.label || data.detail || data.health.length) ? (
        <EdgeLabelRenderer>
          <div
            className="wfc-label nodrag nopan"
            data-edge={id}
            data-merged={data.merged}
            data-return={data.isReturn}
            data-on={data.on}
            data-rel={!data.dim}
            title={data.merged ? `${data.full ?? ""}\n${t("workflows.canvas.openBothStages")}` : (data.full ?? data.kind.tooltip)}
            style={{
              ["--tc" as string]: edgeHue(data.kind),
              transform: `translate(-50%, -50%) translate(${data.labelAt.x}px, ${data.labelAt.y}px)`,
            }}
          >
            {data.isReturn ? `↺ ${data.label || data.kind.label}` : data.label}
            {data.detail ? <span className="wfc-mono">{data.detail}</span> : null}
            {data.health.length ? (
              <span className="wfc-health" data-testid="edge-health">
                {data.health.map((k) => (
                  <HealthMark key={k} kind={k} dot />
                ))}
              </span>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const EDGE_TYPES = { wf: memo(WfEdge) };
