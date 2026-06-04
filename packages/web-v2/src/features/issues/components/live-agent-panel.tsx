"use client";

// ISS-377 Tier-1 live-agent detail. When an agent is actively working the
// issue, surface the current step, runner/device, elapsed time, and a heartbeat
// alive-vs-stale dot (from `agent_sessions.lastHeartbeatAt` vs the 3-min stale
// threshold, AC#3). Deep-links to the agents/session view for the full timeline
// (ISS-376) rather than reimplementing it (AC#8). Raw UUIDs stay in an operator
// expand (AC#6). Renders nothing when no agent is active (no false signal).
import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, Icon, MonoTag } from "@/design";
import { useElapsed } from "@/design/hooks/use-elapsed";
import { heartbeatState } from "../derive";
import type { IssueAgentSession } from "../types";

interface LiveAgentPanelProps {
  session: IssueAgentSession;
  /** Current step label — prefer the active session skill, else the stage. */
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

export function LiveAgentPanel({ session, step, slug, issueId }: LiveAgentPanelProps) {
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
    <Card>
      <CardContent>
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
          <Link
            href={`/projects/${slug}/agents?issue=${issueId}`}
            className="fg-caption ml-auto inline-flex items-center gap-1 text-accent-text transition-opacity hover:opacity-80"
          >
            View timeline
            <Icon name="arrowRight" size={13} />
          </Link>
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
      </CardContent>
    </Card>
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
