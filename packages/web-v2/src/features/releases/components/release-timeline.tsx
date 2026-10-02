"use client";

import { Badge, Tooltip } from "@/design";
import { cn } from "@/lib/utils/cn";
import { shortSha, stampOf } from "../format";
import { type FlowStage, type ReleaseFlow, type StepState, stepStates, stepTip } from "../flow";
import type { ReleaseApproval, ReleaseVersionDetail } from "../versions-types";
import { ApprovalBlock } from "./approval-block";
import { DeploymentRows } from "./deployment-rows";
import { STEP_COLOR } from "./flow-strip";

const STATE_BADGE: Partial<Record<StepState, { label: string; tone: "green" | "cobalt" | "amber" | "red" | "neutral" }>> = {
  current: { label: "in progress", tone: "cobalt" },
  waiting: { label: "waiting", tone: "amber" },
  failed: { label: "failed", tone: "red" },
  aborted: { label: "aborted", tone: "neutral" },
};

function ApprovalLine({ a }: { a: ReleaseApproval }) {
  return (
    <div className="grid gap-0.5 text-12" data-testid="approval-record">
      <span className="text-muted">
        asked by {a.requestedBy.name} · {stampOf(a.requestedAt)} ·{" "}
        <Tooltip label={a.evidence.reading} multiline>
          <span>
            <b className="font-semibold text-fg">{a.evidence.environment}</b>{" "}
            <span className="font-mono">{shortSha(a.evidence.commit)}</span>
          </span>
        </Tooltip>
      </span>
      {a.decision ? (
        <span className={a.decision === "approved" ? "text-green" : "text-amber"}>
          {a.decision} by {a.decidedBy?.name ?? "someone"}
          {a.decidedAt ? ` · ${stampOf(a.decidedAt)}` : ""}
          {a.reason ? <span className="text-muted"> · {a.reason}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

interface StepBodyProps {
  v: ReleaseVersionDetail;
  stage: FlowStage;
  flow: ReleaseFlow;
  projectId: string;
  canDecide: boolean;
  open: string | null;
  onToggle: (id: string) => void;
}

function StepBody({ v, stage, flow, projectId, canDecide, open, onToggle }: StepBodyProps) {
  if (stage.kind === "approval") {
    const latest = v.approvals[0] ?? null;
    const earlier = [...v.approvals.slice(latest && latest.decision !== "approved" ? 1 : 0)].reverse();
    return (
      <div className="grid gap-2">
        {earlier.map((a) => (
          <ApprovalLine key={a.id} a={a} />
        ))}
        {latest && latest.decision !== "approved" && (v.status === "awaiting_approval" || v.status === "returned") ? (
          <ApprovalBlock projectId={projectId} approval={latest} canDecide={canDecide} issueCount={v.issueCount} />
        ) : null}
        {!latest && v.status === "awaiting_approval" ? (
          <span className="text-12 text-amber" data-testid="approval-required">
            required · not asked yet
          </span>
        ) : null}
      </div>
    );
  }
  if (stage.key === flow.deployKey) {
    if (v.attempts.length === 0) return null;
    return (
      <DeploymentRows
        attempts={v.attempts}
        bounds={v.bounds}
        environment={v.environment}
        open={open}
        onToggle={onToggle}
        bare
      />
    );
  }
  return null;
}

function stampFor(v: ReleaseVersionDetail, stage: FlowStage, flow: ReleaseFlow): string | null {
  if (stage.kind === "cut") return stampOf(v.openedAt);
  if (stage.kind === "live") return v.releasedAt ? stampOf(v.releasedAt) : null;
  if (stage.key === flow.deployKey) {
    const first = v.attempts[0];
    return first ? stampOf(first.startedAt) : null;
  }
  return null;
}

export interface ReleaseTimelineProps {
  v: ReleaseVersionDetail;
  flow: ReleaseFlow;
  projectId: string;
  canDecide: boolean;
  open: string | null;
  onToggle: (id: string) => void;
}

/** The flow strip's stages, top to bottom, with what each recorded for this version. */
export function ReleaseTimeline({ v, flow, projectId, canDecide, open, onToggle }: ReleaseTimelineProps) {
  const states = stepStates(v, flow);
  const stages = flow.stages.filter((s) => s.kind !== "draft");
  return (
    <ol className="grid" data-testid="release-timeline">
      {stages.map((stage, i) => {
        const st = states[flow.stages.indexOf(stage)];
        const badge = STATE_BADGE[st];
        const stamp = stampFor(v, stage, flow);
        const quiet = st === "pending" || st === "untracked" || st === "skipped";
        return (
          <li key={stage.key} className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-3" data-testid="timeline-step" data-state={st}>
            <span className="relative flex justify-center">
              <i
                className={cn(
                  "relative z-10 mt-1 block size-2.5 rounded-full",
                  quiet && "border border-line-strong",
                  st === "untracked" && "border-dashed",
                )}
                style={{ background: STEP_COLOR[st] }}
                aria-hidden
              />
              {i < stages.length - 1 ? <span className="absolute bottom-0 top-4 w-px bg-line" aria-hidden /> : null}
            </span>
            <div className="grid gap-1.5 pb-4">
              <Tooltip label={stepTip(v, stage, st, flow.deployKey)} multiline>
                <span className={cn("flex flex-wrap items-center gap-2 text-13", quiet && "text-subtle")}>
                  <b className="font-semibold">{stage.label}</b>
                  {stage.env ? <span className="font-mono text-11 text-subtle">{stage.env.trigger}</span> : null}
                  {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
                  {stage.kind === "live" && v.releasedAt && !v.current ? <Badge>superseded</Badge> : null}
                  {stamp ? <span className="text-12 text-subtle">{stamp}</span> : null}
                </span>
              </Tooltip>
              <StepBody v={v} stage={stage} flow={flow} projectId={projectId} canDecide={canDecide} open={open} onToggle={onToggle} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
