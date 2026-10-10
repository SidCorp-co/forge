
// ISS-377 Tier-1 live-agent detail: the current step, runner/device, elapsed
// time, and a heartbeat alive-vs-stale dot, deep-linking to the agents view for
// the full timeline rather than reimplementing it. ISS-903 added the QUEUED
// arm, for a job that is queued but not yet dispatched: it has no
// `agent_sessions` row, so this panel and everything else derived from sessions
// rendered nothing while the step sat behind a gate. The two arms are one
// discriminated union rather than two components, which makes "renders nothing
// when there is neither" the caller's obligation and the type's to enforce.

import { type ReactNode, useState } from "react";
import { Link } from "@/lib/navigation/router";
import { Icon, MonoTag, Section } from "@/design";
import { useElapsed } from "@/design/hooks/use-elapsed";
import { WORK_STEP_LABELS } from "@forge/contracts/issue-vocabulary";
import { enumLabel } from "@/design/vocabulary";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { useGateReading } from "../gate-reading";
import type { QueuedStepView } from "../waiting";
import type { IssueAgentSession } from "../types";
import { issueSessionsHref } from "@/lib/routes/agents";

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

const HEARTBEAT_DOT: Record<IssueAgentSession["heartbeat"], string> = {
  alive: "var(--ok-9)",
  stale: "var(--danger-9)",
  unknown: "var(--neutral-8)",
};

export function LiveAgent({ state, step, slug, issueId }: LiveAgentPanelProps) {
  return (
    <Section>
        {state.kind === "live" ? (
          <LiveSession session={state.session} step={step} slug={slug} issueId={issueId} />
        ) : (
          <QueuedStep step={state.step} slug={slug} issueId={issueId} />
        )}
      </Section>
  );
}

function LiveSession({
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
  const t = useCopy();
  const language = useInterfaceLanguage();

  const running = session.status === "running";
  const startIso = session.startedAt ?? session.createdAt;
  const startMs = startIso ? Date.parse(startIso) : undefined;
  const elapsed = useElapsed(Number.isNaN(startMs) ? undefined : startMs, running);

  const hb = session.heartbeat;
  const hbMeta = { dot: HEARTBEAT_DOT[hb], label: t(`issues.live.heartbeat.${hb}`) };

  const device = session.deviceId ? session.deviceId.slice(0, 8) : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-2">
          <Icon name="agent" size={16} />
          <span className="fg-label">{running ? t("issues.live.running") : t("issues.live.queued")}</span>
        </span>
        <Stat icon="pipeline" label={t("issues.live.step")} value={step === "—" ? step : enumLabel(step in WORK_STEP_LABELS ? "step" : "jobType", step, language)} mono />
        {device && <Stat icon="cpu" label={t("issues.live.runner")} value={device} mono />}
        <Stat icon="clock" label={t("issues.live.elapsed")} value={elapsed} mono />
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

      <OperatorDetails tags={[["session", session.id], ["run", session.pipelineRunId], ["claude", session.claudeSessionId], ["device", session.deviceId]]} />
    </>
  );
}

/** The queued arm: what has not dispatched, why, for how long, and when next.
 *  No heartbeat dot and no runner — there is no session to have either, and an
 *  "unknown heartbeat" grey dot would read as a dead agent rather than an
 *  absent one. */
function QueuedStep({
  step,
  slug,
  issueId,
}: {
  step: QueuedStepView;
  slug: string;
  issueId: string;
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const gate = useGateReading(step.gate);
  const nextAttempt = time.countdown(step.retryAfterAt);
  const queuedMs = Date.parse(step.queuedAt);
  const waited = useElapsed(Number.isNaN(queuedMs) ? undefined : queuedMs, true);

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-2">
          <Icon name="agent" size={16} />
          <span className="fg-label">{t("issues.live.queued")}</span>
        </span>
        <Stat icon="pipeline" label={t("issues.live.step")} value={enumLabel("jobType", step.jobType, language)} mono />
        <Stat icon="clock" label={t("issues.live.waited")} value={waited} mono />
        {nextAttempt && (
          <Stat icon="clock" label={t("issues.live.nextAttempt")} value={nextAttempt} />
        )}
        <TimelineLink slug={slug} issueId={issueId} />
      </div>

      <p className="fg-body-sm mt-2 text-muted">
        {gate ? gate.detail : t("issues.live.awaitingTurn")}
      </p>
      {gate && <p className="fg-caption mt-1 text-muted">{gate.who}</p>}

      <OperatorDetails tags={[["job", step.jobId], ["gate", step.gate?.reason]]} />
    </>
  );
}

function TimelineLink({ slug, issueId }: { slug: string; issueId: string }) {
  const t = useCopy();
  return (
    <Link
      href={issueSessionsHref(slug, issueId)}
      className="fg-caption ml-auto inline-flex items-center gap-1 text-accent-text transition-opacity hover:opacity-80"
    >
      {t("issues.live.viewTimeline")}
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

/** Which id an operator tag names: the last segment of its copy key, `issues.live.ops.<tag>`. */
type OperatorTag = "session" | "run" | "claude" | "device" | "job" | "gate" | "status";

/** The ids an operator reads a run by, folded under one quiet toggle; an absent value is left out. */
export function OperatorDetails({ tags, children }: { tags: [tag: OperatorTag, value: string | null | undefined][]; children?: ReactNode }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen((v) => !v)} className="fg-caption mt-2 inline-flex items-center gap-1 text-muted transition-colors hover:text-fg" aria-expanded={open}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        {t("issues.live.operatorDetails")}
      </button>
      {open ? (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-line-subtle pt-2">
          {tags.filter((tag): tag is [OperatorTag, string] => !!tag[1]).map(([tag, value]) => (
            <span key={tag} className="inline-flex items-center gap-1">
              <span className="fg-caption text-muted">{t(`issues.live.ops.${tag}`)}</span>
              <MonoTag hue="neutral">{value}</MonoTag>
            </span>
          ))}
          {children}
        </div>
      ) : null}
    </>
  );
}
