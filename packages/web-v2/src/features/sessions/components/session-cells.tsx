import { useRouter } from "next/navigation";
import { Badge, HealthDot, Icon, MonoTag, StatusChip, Tooltip } from "@/design";
import { IssueRefBadge } from "@/features/issues/components/issue-ref-badge";
import {
  type StuckRuns,
  deriveLiveness,
  isAwaitingReply,
  sessionKind,
  statusToChip,
  classifySessionOutcome,
  failureReasonLabel,
  SESSION_KIND_LABEL,
  type AgentSessionDisplayStatus,
  type AgentSessionKind,
  type SessionRow,
} from "../types";

/** `m ss` / `s` countdown for the reap-window label. */
function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Title + issue/agent identity shared by table + card layouts. The title
 *  opens the session detail (when a slug is resolvable); the issue tag links
 *  back to the issue. */
export function SessionIdentity({
  row,
  slug,
  onOpen,
}: {
  row: SessionRow;
  slug?: string;
  onOpen?: () => void;
}) {
  const router = useRouter();
  const issueId = row.metadata?.issueId;
  const kind = sessionKind(row);
  const title = row.title ?? "Untitled session";
  return (
    <div className="min-w-0">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="block w-full text-left focus-visible:outline-none"
        >
          <span className="fg-body-sm block truncate text-fg hover:text-accent-text">{title}</span>
        </button>
      ) : (
        <p className="fg-body-sm truncate text-fg">{title}</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {/* Pipeline (job-driven) vs interactive chat — a running chat spawns no
            job, so it is NOT a wedged runner (ISS-378 AC#4). */}
        <Tooltip
          label={
            kind === "chat"
              ? "Interactive chat — spawns no pipeline job, so a running chat is not a wedged runner."
              : "Pipeline session — driven by a pipeline job on a runner."
          }
        >
          <MonoTag hue={kind === "chat" ? "flame" : "cobalt"}>{kind}</MonoTag>
        </Tooltip>
        {issueId &&
          (slug ? (
            <IssueRefBadge id={issueId} slug={slug} />
          ) : (
            <span className="fg-caption truncate">{issueId}</span>
          ))}
        {/* Jump to the pipeline-run timeline (ISS-378 AC#3). */}
        {row.pipelineRunId && (
          <Tooltip label="Open pipeline run timeline">
            <button
              type="button"
              onClick={() => router.push(`/ops?run=${row.pipelineRunId}`)}
              className="inline-flex items-center gap-1 focus-visible:outline-none"
            >
              <MonoTag hue="neutral">
                <Icon name="pipeline" size={11} className="-mt-px inline" /> run
              </MonoTag>
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** Runner/device cell: friendly name (or short id for an unknown owner's
 *  device) + a shared-threshold alive/stale dot for live sessions. */
export function RunnerCell({
  row,
  deviceName,
  display,
  now,
  stuck,
}: {
  row: SessionRow;
  deviceName?: string;
  display: AgentSessionDisplayStatus;
  now: number;
  stuck: StuckRuns;
}) {
  if (!row.deviceId) return <span className="fg-caption text-subtle">—</span>;
  const live = display === "running" || display === "stalled";
  const liveness = live ? deriveLiveness(row, stuck, now) : null;
  const health =
    liveness?.state === "stale" || liveness?.state === "reaping"
      ? "attention"
      : liveness?.state === "alive"
        ? "healthy"
        : null;
  return (
    <div className="flex items-center gap-1.5 overflow-hidden">
      {health && <HealthDot health={health} withLabel={false} />}
      {deviceName ? (
        <span className="truncate fg-body-sm text-muted" title={deviceName}>
          {deviceName}
        </span>
      ) : (
        <MonoTag hue="neutral">{row.deviceId.slice(0, 8)}</MonoTag>
      )}
    </div>
  );
}

export function StatusCell({
  row,
  display,
  stage,
  now,
  stuck,
}: {
  row: SessionRow;
  display: AgentSessionDisplayStatus;
  stage: string | undefined;
  now: number;
  stuck: StuckRuns;
}) {
  const liveness = deriveLiveness(row, stuck, now);
  // ISS-664 — a finished interactive chat awaiting the owner's reply gets its
  // own distinct chip (the `waiting` StatusKey — amber "a human must act"),
  // taking priority over the generic idle→paused mapping used everywhere else
  // (ChatScreen/SessionScreen keep that mapping unchanged; this is list-only).
  const awaitingReply = isAwaitingReply(row);
  const outcome = classifySessionOutcome(display, row.failureReason);
  const chipStatus = awaitingReply
    ? "waiting"
    : outcome.bucket === "active"
      ? statusToChip(display)
      : outcome.statusKey;
  const reason = failureReasonLabel(row.failureReason) ?? row.failureReason ?? null;
  const showReason =
    !!reason && (display === "failed" || display === "stalled" || display === "cancelled_stale");
  const subLine = showReason ? reason : display === "cancelled" ? outcome.label : null;
  // Red reason text only for a genuine failure; swept/cleanup reads subtle.
  const reasonColor = outcome.bucket === "failed" ? "var(--amberw-600)" : "var(--fg-subtle)";
  return (
    <div className="flex flex-col items-start gap-1">
      {!awaitingReply && outcome.tooltip ? (
        <Tooltip label={outcome.tooltip}>
          <StatusChip status={chipStatus} stage={stage} domain="session" />
        </Tooltip>
      ) : (
        <StatusChip status={chipStatus} stage={stage} domain="session" />
      )}
      {subLine && (
        <span className="fg-caption" style={{ color: reasonColor }}>
          {subLine}
        </span>
      )}
      {liveness.state === "stale" && liveness.reapInMs != null && (
        <span className="fg-caption text-subtle" title="Time until the server auto-recovers this session">
          auto-recovers in {formatCountdown(liveness.reapInMs)}
        </span>
      )}
      {liveness.state === "reaping" && (
        <span className="fg-caption text-subtle">awaiting auto-recovery…</span>
      )}
    </div>
  );
}

/** What species the row says it is: one word per kind, four of them. */
const KIND_TONE = {
  master: "accent",
  run_session: "cobalt",
  pipeline: "neutral",
  chat: "neutral",
} as const satisfies Record<AgentSessionKind, "neutral" | "accent" | "cobalt">;

export function SessionKindTag({ row }: { row: SessionRow }) {
  const kind = sessionKind(row);
  return <Badge tone={KIND_TONE[kind]}>{SESSION_KIND_LABEL[kind]}</Badge>;
}
