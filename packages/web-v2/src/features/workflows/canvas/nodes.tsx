"use client";

import type { TemplateNodeType } from "@forge/contracts/workflow-templates";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { ChevronRight, Clock, User } from "lucide-react";
import { memo } from "react";
import { Button, CardTitle, TemplateIcon } from "@/design";
import type { StepMark } from "../design-diff";
import type { WorkflowStep } from "../types";
import type { BandSummary } from "./model";
import { titleOf, purposeOf } from "./model";
import { hue, tint } from "./style";
import { WireframeThumb } from "./wireframe-thumb";

export interface StepNodeData extends Record<string, unknown> {
  step: WorkflowStep;
  type: TemplateNodeType;
  lane: string | null;
  full: boolean;
  contract: boolean;
  on: boolean;
  rel: boolean;
  hit: boolean;
  visited: boolean;
  mark: StepMark | null;
}

export interface BandNodeData extends Record<string, unknown> {
  label: string;
  summary: BandSummary;
  hits: number;
  rel: boolean;
}

export interface BandRowData extends Record<string, unknown> {
  label: string;
  tooltip: string;
  colour: string;
  odd: boolean;
  open: boolean;
  onToggle: () => void;
}

const ends = (
  <>
    <Handle type="target" position={Position.Top} isConnectable={false} />
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </>
);

export function TypeChip({ type }: { type: TemplateNodeType }) {
  return (
    <span className="wfc-chip" style={{ ["--tc" as string]: hue(type.colour) }}>
      <TemplateIcon icon={type.icon} size={13} />
      {type.label}
    </span>
  );
}

function StepCard({ data }: NodeProps & { data: StepNodeData }) {
  const { step, type, full, contract } = data;
  const n = step.node;
  return (
    <div
      className="wfc-card"
      style={{ ["--tc" as string]: hue(type.colour) }}
      data-compact={!full}
      data-on={data.on}
      data-rel={data.rel}
      data-hit={data.hit}
      data-visited={data.visited}
      data-mark={data.mark ?? undefined}
      data-designed={step.status === "designed" || step.status === "writing"}
      data-testid="workflow-node"
      data-step={step.id}
      title={full ? undefined : purposeOf(step)}
    >
      {ends}
      <TypeChip type={type} />
      {contract ? (
        <span className="wfc-mono">
          {step.id}
          {data.lane ? ` · ${data.lane}` : ""}
        </span>
      ) : null}
      <CardTitle className="fg-h4">{titleOf(step)}</CardTitle>
      {full ? (
        <>
          <p>{purposeOf(step)}</p>
          {n?.wireframe?.svg ? <WireframeThumb attachment={n.wireframe.svg} title={titleOf(step)} /> : null}
          {n?.conditions?.length ? (
            <ul>
              {n.conditions.map((r) => (
                <li key={`${r.when}>${r.result}`}>
                  {r.when} → <b>{r.result}</b>
                </li>
              ))}
            </ul>
          ) : null}
          {n?.owner || n?.sla ? (
            <div className="wfc-badges">
              {n.owner ? (
                <span className="wfc-badge">
                  <User size={12} aria-hidden />
                  {n.owner}
                </span>
              ) : null}
              {n.sla ? (
                <span className="wfc-badge" data-tone="sla">
                  <Clock size={12} aria-hidden />
                  {n.sla}
                </span>
              ) : null}
            </div>
          ) : null}
          {contract && n?.outputs?.length ? (
            <span className="wfc-mono" data-rule="true">
              out: {n.outputs.join(" · ")}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function BandCard({ data }: NodeProps & { data: BandNodeData }) {
  const { summary } = data;
  return (
    <div className="wfc-card" data-summary="true" data-rel={data.rel} data-hit={data.hits > 0} data-testid="workflow-band">
      {ends}
      <div className="wfc-sum">
        <CardTitle className="fg-h4">{data.label}</CardTitle>
        <span className="wfc-count">
          {summary.count} {summary.count === 1 ? "step" : "steps"}
        </span>
      </div>
      <div className="wfc-types">
        {summary.types.map(({ type, count }) => (
          <span key={type.id} style={{ ["--tc" as string]: hue(type.colour) }}>
            <TemplateIcon icon={type.icon} size={13} />
            {type.label}
            {count > 1 ? ` ×${count}` : ""}
          </span>
        ))}
      </div>
      <div className="wfc-badges">
        <span className="wfc-badge">
          <User size={12} aria-hidden />
          {summary.owners === 0 ? "no owner named" : `${summary.owners} ${summary.owners === 1 ? "owner" : "owners"}`}
        </span>
        {summary.deadlines > 0 ? (
          <span className="wfc-badge" data-tone="sla">
            <Clock size={12} aria-hidden />
            {summary.deadlines} {summary.deadlines === 1 ? "deadline" : "deadlines"}
          </span>
        ) : null}
        {data.hits > 0 ? (
          <span className="wfc-badge" data-tone="hits">
            {data.hits} found
          </span>
        ) : null}
      </div>
    </div>
  );
}

function BandRow({ data }: NodeProps & { data: BandRowData }) {
  return (
    <div className="wfc-row" style={{ background: tint(data.colour, data.odd ? 4 : 7) }}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="wfc-row-label nodrag nopan"
        aria-expanded={data.open}
        title={`${data.tooltip} — click to ${data.open ? "fold" : "open"}`}
        onClick={(e) => {
          e.stopPropagation();
          data.onToggle();
        }}
      >
        <ChevronRight size={12} aria-hidden />
        {data.label}
      </Button>
    </div>
  );
}

export const NODE_TYPES = { step: memo(StepCard), band: memo(BandCard), bandRow: memo(BandRow) };
