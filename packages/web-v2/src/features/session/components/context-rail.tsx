"use client";

// Context rail for the run thread: the session's status chip + run stats + a
// files-changed list derived from edit-tool blocks across turns (no diff REST
// endpoint exists). Collapses into a SlideOver below `lg` (handled by the
// parent). Kit-only tokens; cost/model are not on the session row → show "—".
//
// ISS-352 enrichment (frontend-only, every field proven present in the
// `GET /agent-sessions/:id` row): cache tokens + lifecycle timings + repoPath,
// an "Agents & tasks" list (derived from Task/Skill transcript blocks), and a
// "Sessions for this issue" list (sibling sessions via the existing list API).

import { useRouter } from "next/navigation";
import { Banner, enumLabel, Icon, MonoTag, FactsGroup, Stat, StatusBadge, useElapsed } from "@/design";
import { deriveSessionDisplayStatus, failureReasonAction, failureReasonLabel, sessionStep, statusToChip, type SessionRow } from "@/features/sessions";
import { useStuckRuns } from "@/features/agents";
import { useSessionCost, useSessions } from "@/features/sessions";
import { sessionKind } from "@/features/sessions";
import { type RunGateNote, runGateNote, runGateUnfetched } from "@/features/pipeline";
import { formatRefusal } from "@/lib/api/error";
import { useRailCopy, useRailLanguage, useRailTime } from "../chrome-language";
import { useRun } from "@/features/pipeline";
import { deriveAgentTasks, deriveFilesChanged } from "../derive";
import type { ConversationItem } from "../types";
import { HeldReplyForRun } from "./held-reply-for-run";
import { LoadedForRun } from "./loaded-for-run";
import { RailRunner } from "./rail-runner";
import { formatDuration, formatUsd } from "@/lib/i18n/format";

const GATE_TONE: Record<RunGateNote["verdict"], "info" | "attention" | "success"> = {
  none: "info",
  clear: "success",
  marked: "attention",
  failing_open: "attention",
  unreadable: "attention",
};

export function ContextRail({ session, items, projectSlug }: { session: SessionRow; items: ConversationItem[]; projectSlug?: string }) {
  const router = useRouter();
  const t = useRailCopy();
  const language = useRailLanguage();
  const stuck = useStuckRuns(session.projectId);
  const display = deriveSessionDisplayStatus(session, stuck);
  const live = display === "running" || display === "stalled";
  const agentTasks = deriveAgentTasks(items);
  // Only a run session's run is opened by the box with its gate condition (ISS-1192).
  const isRunSession = sessionKind(session) === "run_session";
  const runQ = useRun(session.pipelineRunId ?? undefined, isRunSession && !!session.pipelineRunId);
  // A failed refetch keeps the data it already read, and that stays the answer.
  const gateNote = !isRunSession
    ? null
    : runQ.data
      ? runGateNote(runQ.data.gateAtOpen, language)
      : runQ.isError
        ? runGateUnfetched(formatRefusal(runQ.error), language)
        : null;
  const issueId = session.metadata?.issueId;
  const siblingsQ = useSessions({ projectId: session.projectId });
  const siblings = (() => {
    if (!issueId) return [];
    return (siblingsQ.data?.items ?? []).filter((s) => s.id !== session.id && s.metadata?.issueId === issueId);
  })();

  // On-failure blocker-card: concrete reason + a one-line suggested next action.
  const failureReason = session.failureReason ?? null;
  const showBlocker = !!failureReason && (display === "failed" || display === "stalled" || display === "cancelled_stale");

  return (
    <div>
      {session.deviceId && <RailRunner session={session} deviceId={session.deviceId} />}

      {gateNote && (
        <FactsGroup title={t("sessions.rail.gate")}>
          <Banner tone={GATE_TONE[gateNote.verdict]}>
            <span className="font-semibold">{gateNote.headline}</span>
            <span className="mt-0.5 block">{gateNote.detail}</span>
            {gateNote.reason && <span className="mt-0.5 block">{gateNote.reason}</span>}
          </Banner>
        </FactsGroup>
      )}

      <RailStats session={session} live={live} />

      {/* Agents & tasks — elevated directly under Run stats (ISS-391) so a
          session's task breakdown is the first thing seen after the headline
          stats. Renders only when the transcript yielded Task/Skill blocks. */}
      <RailTasks tasks={agentTasks} />

      {showBlocker && (
        <FactsGroup title={t("sessions.rail.blocked")}>
          <Banner tone={failureReason === "user_cancelled" ? "attention" : "danger"}>
            <span className="font-semibold">{failureReasonLabel(failureReason, language) ?? failureReason}</span>
            {failureReasonAction(failureReason, language) && (
              <span className="mt-0.5 block">{failureReasonAction(failureReason, language)}</span>
            )}
          </Banner>
        </FactsGroup>
      )}

      <HeldReplyForRun metadata={session.metadata} />

      <LoadedForRun metadata={session.metadata} />

      <RailTiming session={session} live={live} />

      {issueId && siblings.length > 0 && (
        <FactsGroup title={t("sessions.rail.siblings", { n: siblings.length })}>
          {/* Resumed/fresh continuity is the issue detail's session-group timeline; not repeated here. */}
          <ul className="flex flex-col gap-1.5">
            {siblings.map((s) => (
              <SiblingSession
                key={s.id}
                row={s}
                onOpen={projectSlug ? () => router.push(`/projects/${projectSlug}/agents/${s.id}`) : undefined}
              />
            ))}
          </ul>
        </FactsGroup>
      )}

      <RailFiles files={deriveFilesChanged(items)} />
    </div>
  );
}

/** Turns, duration, context, tokens, cache, cost and models; the cost is the session's usage_records rollup (ISS-378). */
function RailStats({ session, live }: { session: SessionRow; live: boolean }) {
  const t = useRailCopy();
  const language = useRailLanguage();
  const time = useRailTime();
  const startMs = session.startedAt ? new Date(session.startedAt).getTime() : undefined;
  const elapsed = useElapsed(startMs, live);
  const duration = !startMs ? "—" : live ? elapsed : formatDuration(new Date(session.updatedAt).getTime() - startMs, language);
  const usage = session.usage ?? {};
  const hasCache = usage.cacheRead != null || usage.cacheWrite != null;
  const cost = useSessionCost(session.id).data;
  const [firstModel, ...otherModels] = cost?.models ?? [];
  const modelLabel = !firstModel
    ? null
    : otherModels.length === 0
      ? firstModel.model
      : t("sessions.rail.models", { n: otherModels.length + 1 });
  return (
    <FactsGroup title={t("sessions.rail.stats")}>
      <div className="flex flex-col gap-2.5">
        <Stat icon="activity" title={t("sessions.rail.turnsTitle")}>
          {usage.turns != null ? t("sessions.rail.turns", { n: time.number(usage.turns) }) : "—"}
        </Stat>
        <Stat icon="clock" title={t("sessions.rail.durationTitle")}>
          {duration}
        </Stat>
        <Stat icon="cpu" title={t("sessions.rail.contextTitle")}>
          {t("sessions.rail.ctx", {
            n: (usage.contextUsed == null ? "—" : time.compact(usage.contextUsed)),
          })}
        </Stat>
        <Stat icon="arrowRight" title={t("sessions.rail.tokensTitle")}>
          {t("sessions.rail.tok", {
            in: (usage.inputTotal == null ? "—" : time.compact(usage.inputTotal)),
            out: (usage.outputTotal == null ? "—" : time.compact(usage.outputTotal)),
          })}
        </Stat>
        {hasCache && (
          <Stat icon="cpu" title={t("sessions.rail.cacheTitle")}>
            {t("sessions.rail.cache", {
              read: (usage.cacheRead == null ? "—" : time.compact(usage.cacheRead)),
              write: (usage.cacheWrite == null ? "—" : time.compact(usage.cacheWrite)),
            })}
          </Stat>
        )}
        <Stat icon="dollar" title={t("sessions.rail.costTitle")}>
          {t("sessions.rail.cost", {
            amount: formatUsd(cost?.estimatedCost, language),
          })}
        </Stat>
        {modelLabel && (
          <Stat icon="cpu" title={t("sessions.rail.modelsTitle")}>
            {modelLabel}
          </Stat>
        )}
      </div>
    </FactsGroup>
  );
}

/** Agents and skills the transcript ran (ISS-391), right under the stats. */
function RailTasks({ tasks }: { tasks: ReturnType<typeof deriveAgentTasks> }) {
  const t = useRailCopy();
  if (tasks.length === 0) return null;
  const agentTasks = tasks;
  return (
    <FactsGroup title={t("sessions.rail.agentsTasks", { n: agentTasks.length })}>
      <ul className="flex flex-col gap-1.5">
        {agentTasks.map((a) => (
          <li key={a.id} className="flex items-center gap-2 overflow-hidden">
            <Icon name={a.tool === "Skill" ? "command" : "agent"} size={13} className="flex-none text-subtle" />
            <span className="flex-1 truncate fg-body-sm" title={a.label}>
              {a.label}
            </span>
            {a.isError && <Icon name="alert" size={12} className="flex-none text-danger-11" />}
            <MonoTag hue={a.tool === "Skill" ? "flame" : "cobalt"}>{a.tool}</MonoTag>
          </li>
        ))}
      </ul>
    </FactsGroup>
  );
}

function RailTiming({ session, live }: { session: SessionRow; live: boolean }) {
  const t = useRailCopy();
  const time = useRailTime();
  return (
    <FactsGroup title={t("sessions.rail.timing")}>
      <div className="flex flex-col gap-2.5">
        <Stat icon="calendar" title={t("sessions.rail.dispatchedTitle")}>
          {t("sessions.rail.dispatched", {
            at: time.when(session.dispatchedAt),
          })}
        </Stat>
        <Stat icon="play" title={t("sessions.rail.startedTitle")}>
          {t("sessions.rail.started", {
            at: time.when(session.startedAt),
          })}
        </Stat>
        <Stat icon="check" title={t("sessions.rail.endedTitle")}>
          {t("sessions.rail.ended", {
            at: live ? "—" : time.when(session.updatedAt),
          })}
        </Stat>
      </div>
    </FactsGroup>
  );
}

function RailFiles({ files }: { files: ReturnType<typeof deriveFilesChanged> }) {
  const t = useRailCopy();
  return (
    <FactsGroup title={files.length ? t("sessions.rail.filesN", { n: files.length }) : t("sessions.rail.files")}>
      {files.length === 0 ? (
        <p className="fg-caption">{t("sessions.rail.noEdits")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {files.map((f) => (
            <li key={f.path} className="flex items-center gap-2 overflow-hidden">
              <Icon name={f.isNew ? "plus" : "branch"} size={13} className="flex-none text-subtle" />
              <span className="flex-1 truncate font-mono text-12" title={f.path}>
                {f.path}
              </span>
              {f.added > 0 && <span className="flex-none font-mono text-12 text-ok-11">+{f.added}</span>}
              {f.removed > 0 && <span className="flex-none font-mono text-12 text-danger-11">-{f.removed}</span>}
            </li>
          ))}
        </ul>
      )}
    </FactsGroup>
  );
}

/** One sibling session in "Sessions for this issue" — step label + status
 *  chip, links to its own detail when a project slug is known. */
function SiblingSession({ row, onOpen }: { row: SessionRow; onOpen?: () => void }) {
  const t = useRailCopy();
  const language = useRailLanguage();
  const stuck = useStuckRuns(row.projectId);
  const display = deriveSessionDisplayStatus(row, stuck);
  const stage = sessionStep(row.metadata) ?? undefined;
  const label = row.metadata?.step ?? row.metadata?.stage ?? row.title ?? t("sessions.detail.sessionShort", { id: row.id.slice(0, 8) });

  const inner = (
    <>
      <Icon name="pipeline" size={13} className="flex-none text-subtle" />
      <span className="flex-1 truncate fg-body-sm" title={label}>
        {row.title && label === row.title ? label : enumLabel("jobType", label, language)}
      </span>
      <StatusBadge family="run" value={statusToChip(display)} stage={stage} />
    </>
  );

  if (!onOpen) {
    return <li className="flex items-center gap-2 overflow-hidden">{inner}</li>;
  }
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2 overflow-hidden rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-hover focus-visible:outline-none"
      >
        {inner}
      </button>
    </li>
  );
}
