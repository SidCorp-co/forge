"use client";

import { Badge, Tooltip } from "@/design";
import type { DesignStatus, WorkflowKind, WorkflowStep } from "../types";

const DESIGN_PILL: Record<DesignStatus, { label: string; tone: "neutral" | "amber" | "green" | "red"; tip: string }> = {
  draft: { label: "Draft", tone: "neutral", tip: "The master is still drawing it; nobody has been asked to approve it" },
  proposed: { label: "Awaiting approval", tone: "amber", tip: "Nothing that builds it is dispatched until it is approved" },
  approved: { label: "Approved", tone: "green", tip: "Work that builds it may start" },
  returned: { label: "Returned", tone: "red", tip: "Sent back to the master to revise" },
};

export function DesignPill({ status, reason }: { status: DesignStatus; reason?: string | null }) {
  const p = DESIGN_PILL[status];
  return (
    <Tooltip label={reason ? `${p.tip}: ${reason}` : p.tip} side="bottom" multiline>
      <span data-testid="design-pill" data-status={status}>
        <Badge tone={p.tone}>{p.label}</Badge>
      </span>
    </Tooltip>
  );
}

function coverageText(step: WorkflowStep): { label: string; tone: "green" | "amber" | "neutral" } | null {
  if (step.status === "designed") return { label: "designed", tone: "neutral" };
  if (step.status === "writing") return { label: "being written", tone: "neutral" };
  const reading = step.evidence?.coverage?.reading;
  if (reading === "walked") return { label: "walked by tests", tone: "green" };
  if (reading === "not_walked") return { label: "not walked · in baseline", tone: "amber" };
  if (reading === "unmeasured") return { label: "not measured by flow coverage", tone: "neutral" };
  return null;
}

function NodeFacts({ step }: { step: WorkflowStep }) {
  const n = step.node;
  if (!n) return null;
  const facts: [string, string][] = [
    ["In", n.inputs?.join(", ") ?? ""],
    ["Out", n.outputs?.join(", ") ?? ""],
    ["Owner", n.owner ?? ""],
    ["SLA", n.sla ?? ""],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-12" data-testid="workflow-node-facts">
      {facts
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <span key={k}>
            <span className="text-subtle">{k}</span> <span className="font-mono">{v}</span>
          </span>
        ))}
    </div>
  );
}

export function StepDetail({ flow, kind, step }: { flow: string; kind: WorkflowKind; step: WorkflowStep }) {
  const cov = coverageText(step);
  const e = step.evidence;
  return (
    <div className="grid gap-1.5 rounded-lg border border-line-subtle bg-surface px-4 py-3.5 text-13" data-testid="workflow-step">
      <div className="flex flex-wrap items-center gap-2.5">
        <b className="font-mono">{kind === "flow" ? `${flow}/${step.id}` : step.id}</b>
        {step.node ? (
          <Tooltip label={step.node.purpose ?? step.node.type} side="bottom" multiline>
            <span>
              <Badge tone="cobalt">{step.node.type}</Badge>
            </span>
          </Tooltip>
        ) : null}
        {cov ? <Badge tone={cov.tone}>{cov.label}</Badge> : null}
        {step.status === "rechecking" ? <Badge tone="amber">re-checking</Badge> : null}
      </div>
      <p>{step.does}</p>
      <NodeFacts step={step} />
      {e && e.kind === "storefront" ? (
        <div className="flex flex-wrap items-center gap-2.5 text-12" data-testid="workflow-evidence">
          <span className="text-subtle">Evidence</span>
          <span>{e.provider}</span>
          <span className="font-mono">
            {e.ref} {e.id}
          </span>
        </div>
      ) : e ? (
        <div className="flex flex-wrap items-center gap-2.5 text-12" data-testid="workflow-evidence">
          <span className="text-subtle">Evidence</span>
          <span className="font-mono">{e.file}</span>
          {e.symbol ? <span className="font-mono text-subtle">{e.symbol}</span> : null}
          {e.annotation ? (
            <span className="text-subtle">cm:flow {e.annotation}</span>
          ) : kind === "flow" ? (
            <span className="text-subtle">no cm:flow annotation yet</span>
          ) : null}
          {e.coverage.atSha ? <span className="font-mono text-subtle">at {e.coverage.atSha.slice(0, 7)}</span> : null}
        </div>
      ) : kind === "flow" && step.status !== "designed" ? (
        <p className="text-12 text-subtle">
          No evidence yet: the master adds the step&rsquo;s cm:flow {flow}/{step.id} annotation as it writes it.
        </p>
      ) : null}
    </div>
  );
}
