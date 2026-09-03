"use client";

// ISS-377 Tier-1 live-agent detail: the current step, runner/device, elapsed
// time, and a heartbeat alive-vs-stale dot, deep-linking to the agents view for
// the full timeline rather than reimplementing it. ISS-903 added the QUEUED
// arm, for a job that is queued but not yet dispatched: it has no
// `agent_sessions` row, so this panel and everything else derived from sessions
// rendered nothing while the step sat behind a gate. The two arms are one
// discriminated union rather than two components, which makes "renders nothing
// when there is neither" the caller's obligation and the type's to enforce.

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, Icon, MonoTag } from "@/design";
import { useElapsed } from "@/design/hooks/use-elapsed";
import { heartbeatState } from "../derive";
import type { QueuedStepView } from "../waiting";
import type { IssueAgentSession } from "../types";

export type LiveAgentState =
  | { kind: "live"; session: IssueAgentSession }
  | { kind: "queued"; step: QueuedStepView };

interface LiveAgentPanelProps {
  state: LiveAgentState;
  /** Current step label — prefer the active session skill, else the stage.
   *  Unused by the queued arm, which names the queued job's own type. */
  step: string;
  slug: string;
  issueId: string;
}

const HEARTBEAT_META: Record<
  ReturnType<typeof heartbeatState>,
  { dot: string; label: string }
> = {
  alive: { dot: "var(--green-500)", label: "Heartbeat alive" },
  stale: { dot: "var(--red-500)", label: "Heartbeat stale" },
  unknown: { dot: "var(--ink-400)", label: "No heartbeat" },
};

export function LiveAgentPanel({ state, step, slug, issueId }: LiveAgentPanelProps) {
  return (
    <Card>
      <CardContent>
        {state.kind === "live" ? (
          <LiveRow session={state.session} step={step} slug={slug} issueId={issueId} />
        ) : (
          <QueuedRow step={state.step} slug={slug} issueId={issueId} />
        )}
      </CardContent>
    </Card>
  );
}

function LiveRow({
  session,
  step,
  slug,
  issueId,
}: {
  session: IssueAgentSession;
  step: string;
  slug: string;
  issueId: string;
}) {
  const [showOps, setShowOps] = useState(false);

  const running = session.status === "running";
  const startIso = session.startedAt ?? session.createdAt;
  const startMs = startIso ? Date.parse(startIso) : undefined;
  const elapsed = useElapsed(Number.isNaN(startMs) ? undefined : startMs, running);

  // Heartbeat from the session field when present; fall back to `updatedAt` for
  // an older server that doesn't surface lastHeartbeatAt yet.
  const hb = heartbeatState(session.lastHeartbeatAt ?? session.updatedAt);
  const hbMeta = HEARTBEAT_META[hb];

  const device = session.deviceId ? session.deviceId.slice(0, 8) : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-2">
          <Icon name="agent" size={16} />
          <span className="fg-label">Agent {running ? "running" : "queued"}</span>
        </span>
        <Stat icon="pipeline" label="Step" value={step} mono />
        {device && <Stat icon="cpu" label="Runner" value={device} mono />}
        <Stat icon="clock" label="Elapsed" value={elapsed} mono />
        <span className="inline-flex items-center gap-1.5" title={hbMeta.label}>
          <span
            aria-hidden
            className={`inline-block size-2 flex-none rounded-full ${hb === "alive" ? "forge-pulse" : ""}`}
            style={{ background: hbMeta.dot }}
          />
          <span className="fg-caption">{hbMeta.label}</span>
        </span>
        <TimelineLink slug={slug} issueId={issueId} />
      </div>

      <button
        type="button"
        onClick={() => setShowOps((v) => !v)}
        className="fg-caption mt-3 inline-flex items-center gap-1 text-muted transition-colors hover:text-fg"
        aria-expanded={showOps}
      >
        <Icon name={showOps ? "chevronDown" : "chevronRight"} size={13} />
        Operator details
      </button>
      {showOps && (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-line-subtle pt-2">
          <OpsTag label="session" value={session.id} />
          {session.pipelineRunId && <OpsTag label="run" value={session.pipelineRunId} />}
          {session.claudeSessionId && <OpsTag label="claude" value={session.claudeSessionId} />}
          {session.deviceId && <OpsTag label="device" value={session.deviceId} />}
        </div>
      )}
    </>
  );
}

/** The queued arm: what has not dispatched, why, for how long, and when next.
 *  No heartbeat dot and no runner — there is no session to have either, and an
 *  "unknown heartbeat" grey dot would read as a dead agent rather than an
 *  absent one. */
// cm:guard the no-gate branch must SAY the step is awaiting its turn — a panel that renders the word "queued" with nothing beside it is the ambiguity ISS-903 closed, on the other side: the reader cannot tell "about to run" from "held for six days"
function QueuedRow({
  step,
  slug,
  issueId,
}: {
  step: QueuedStepView;
  slug: string;
  issueId: string;
}) {
  const [showOps, setShowOps] = useState(false);
  const queuedMs = Date.parse(step.queuedAt);
  const waited = useElapsed(Number.isNaN(queuedMs) ? undefined : queuedMs, true);

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-2">
          <Icon name="agent" size={16} />
          <span className="fg-label">Agent queued</span>
        </span>
        <Stat icon="pipeline" label="Step" value={step.jobType} mono />
        <Stat icon="clock" label="Waited" value={waited} mono />
        {step.nextAttempt && (
          <Stat icon="clock" label="Next attempt" value={step.nextAttempt} />
        )}
        <TimelineLink slug={slug} issueId={issueId} />
      </div>

      <p className="fg-body-sm mt-2 text-muted">
        {step.gate
          ? step.gate.detail
          : "The step is awaiting its turn — it dispatches on the next tick."}
      </p>
      {step.gate && <p className="fg-caption mt-1 text-muted">{step.gate.who}</p>}

      <button
        type="button"
        onClick={() => setShowOps((v) => !v)}
        className="fg-caption mt-3 inline-flex items-center gap-1 text-muted transition-colors hover:text-fg"
        aria-expanded={showOps}
      >
        <Icon name={showOps ? "chevronDown" : "chevronRight"} size={13} />
        Operator details
      </button>
      {showOps && (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-line-subtle pt-2">
          <OpsTag label="job" value={step.jobId} />
          {step.gate && <OpsTag label="gate" value={step.gate.reason} />}
        </div>
      )}
    </>
  );
}

function TimelineLink({ slug, issueId }: { slug: string; issueId: string }) {
  return (
    <Link
      href={`/projects/${slug}/agents?issue=${issueId}`}
      className="fg-caption ml-auto inline-flex items-center gap-1 text-accent-text transition-opacity hover:opacity-80"
    >
      View timeline
      <Icon name="arrowRight" size={13} />
    </Link>
  );
}

function Stat({
  icon,
  label,
  value,
  mono,
}: {
  icon: "pipeline" | "cpu" | "clock";
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon name={icon} size={14} />
      <span className="fg-caption text-muted">{label}</span>
      <span className={mono ? "fg-body-sm font-mono" : "fg-body-sm"}>{value}</span>
    </span>
  );
}

function OpsTag({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="fg-caption text-muted">{label}</span>
      <MonoTag hue="neutral">{value}</MonoTag>
    </span>
  );
}
