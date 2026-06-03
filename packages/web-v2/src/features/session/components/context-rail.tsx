"use client";

// Context rail for the run thread: compact PipelineTracker + run stats + a
// files-changed list derived from edit-tool blocks across turns (no diff REST
// endpoint exists). Collapses into a SlideOver below `lg` (handled by the
// parent). Kit-only tokens; cost/model are not on the session row → show "—".
//
// ISS-352 enrichment (frontend-only, every field proven present in the
// `GET /agent-sessions/:id` row): cache tokens + lifecycle timings + repoPath,
// an "Agents & tasks" list (derived from Task/Skill transcript blocks), and a
// "Sessions for this issue" list (sibling sessions via the existing list API).
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Banner, HealthDot, Icon, MonoTag, PipelineTracker, Stat, StatusChip, useElapsed } from "@/design";
import {
  deriveSessionDisplayStatus,
  deriveStage,
  statusToChip,
  statusToRun,
  FAILURE_REASON_ACTION,
  FAILURE_REASON_LABEL,
  type SessionRow,
} from "@/features/sessions/types";
import { useSessionCost, useSessions } from "@/features/sessions/hooks";
import { useDevices } from "@/features/runners/hooks";
import { deviceHealth } from "@/features/runners/types";
import { deriveAgentTasks, deriveFilesChanged, type ConversationItem } from "../types";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

function fmtNum(n: number | undefined): string {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** USD cost — sub-cent precision for tiny sessions, 2dp otherwise. */
function fmtCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Short absolute timestamp, or "—" when absent/invalid (older rows). */
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      {/* Sticky within the rail's own scroll so the section label stays visible
          while a long list (e.g. Files changed) scrolls past (ISS-351). */}
      <h3 className="fg-caption sticky top-0 z-10 mb-2 bg-app py-1 uppercase tracking-wide">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function ContextRail({
  session,
  items,
  projectSlug,
}: {
  session: SessionRow;
  items: ConversationItem[];
  projectSlug?: string;
}) {
  const router = useRouter();
  const display = deriveSessionDisplayStatus(session);
  const stage = deriveStage(session.metadata);
  const live = display === "running" || display === "stalled";
  const startMs = session.startedAt ? new Date(session.startedAt).getTime() : undefined;
  const elapsed = useElapsed(startMs, live);
  const duration = !startMs
    ? "—"
    : live
      ? elapsed
      : formatDuration(new Date(session.updatedAt).getTime() - startMs);

  const usage = session.usage ?? {};
  const files = deriveFilesChanged(items);
  const agentTasks = useMemo(() => deriveAgentTasks(items), [items]);
  const isPipeline = session.metadata?.type === "pipeline" || session.metadata?.type === "pm";
  const hasCache = usage.cacheRead != null || usage.cacheWrite != null;

  // Resolve the runner the session is bound to. The device may not be in the
  // viewer's owner-scoped list (different owner) → fall back to the short id.
  const devicesQ = useDevices();
  const device = session.deviceId
    ? devicesQ.data?.find((d) => d.id === session.deviceId)
    : undefined;

  // "Sessions for this issue": the other pipeline steps (triage/plan/code/…)
  // that worked the same issue — the honest "multiple agents" view. Reuses the
  // existing list endpoint (WS-invalidated, shared cache with the queue screen)
  // and filters client-side on `metadata.issueId`, exactly as sessions-screen
  // does. No new endpoint / no parentSessionId column needed.
  const issueId = session.metadata?.issueId;
  const siblingsQ = useSessions({ projectId: session.projectId });
  const siblings = useMemo(() => {
    if (!issueId) return [];
    return (siblingsQ.data?.items ?? []).filter(
      (s) => s.id !== session.id && s.metadata?.issueId === issueId,
    );
  }, [siblingsQ.data, issueId, session.id]);

  // Real per-session cost from usage_records (ISS-378 AC#6) — the session row
  // itself carries no dollar cost/model.
  const costQ = useSessionCost(session.id);
  const cost = costQ.data;
  const modelLabel =
    cost && cost.models.length > 0
      ? cost.models.length === 1
        ? cost.models[0]!.model
        : `${cost.models.length} models`
      : null;

  // On-failure blocker-card: concrete reason + a one-line suggested next action.
  const failureReason = session.failureReason ?? null;
  const showBlocker =
    !!failureReason && (display === "failed" || display === "stalled" || display === "cancelled_stale");

  return (
    <div className="flex flex-col gap-6">
      {session.deviceId && (
        <Section title="Runner">
          {device ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 overflow-hidden">
                <Icon name="server" size={14} className="flex-none text-subtle" />
                <span className="flex-1 truncate fg-body-sm" title={device.name}>
                  {device.name}
                </span>
                <HealthDot health={deviceHealth(device.status)} />
              </div>
              <span className="fg-caption">
                {PLATFORM_LABEL[device.platform] ?? device.platform}
                {device.agentVersion ? ` · v${device.agentVersion}` : ""}
              </span>
              {session.repoPath && (
                <div className="flex items-center gap-2 overflow-hidden">
                  <Icon name="folder" size={13} className="flex-none text-subtle" />
                  <span className="flex-1 truncate font-mono" style={{ fontSize: 11.5 }} title={session.repoPath}>
                    {session.repoPath}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 overflow-hidden">
                <Icon name="server" size={14} className="flex-none text-subtle" />
                <MonoTag hue="neutral">{session.deviceId.slice(0, 8)}</MonoTag>
              </div>
              {session.repoPath && (
                <div className="flex items-center gap-2 overflow-hidden">
                  <Icon name="folder" size={13} className="flex-none text-subtle" />
                  <span className="flex-1 truncate font-mono" style={{ fontSize: 11.5 }} title={session.repoPath}>
                    {session.repoPath}
                  </span>
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {isPipeline && (
        <Section title="Pipeline">
          <PipelineTracker stage={stage} status={statusToRun(display)} variant="compact" />
          <div className="mt-3">
            <StatusChip status={statusToChip(display)} stage={stage} size="sm" domain="session" />
          </div>
        </Section>
      )}

      <Section title="Run stats">
        <div className="flex flex-col gap-2.5">
          {!isPipeline && <StatusChip status={statusToChip(display)} stage={stage} size="sm" domain="session" />}
          <Stat icon="activity" title="Turns">{usage.turns ?? "—"} turns</Stat>
          <Stat icon="clock" title="Duration">{duration}</Stat>
          <Stat icon="cpu" title="Context window used">{fmtNum(usage.contextUsed)} ctx</Stat>
          <Stat icon="arrowRight" title="Tokens in / out">
            {fmtNum(usage.inputTotal)} / {fmtNum(usage.outputTotal)} tok
          </Stat>
          {hasCache && (
            <Stat icon="cpu" title="Cache tokens read / write">
              {fmtNum(usage.cacheRead)} / {fmtNum(usage.cacheWrite)} cache
            </Stat>
          )}
          {/* Real per-session cost + model, aggregated from usage_records via
              GET /agent-sessions/:id/cost (ISS-378). "—" only while loading or
              when no usage rows exist yet. */}
          <Stat icon="dollar" title="Estimated cost (usage_records)">
            {cost ? fmtCost(cost.estimatedCost) : "—"} cost
          </Stat>
          {modelLabel && (
            <Stat icon="cpu" title="Model(s) billed against this session">
              {modelLabel}
            </Stat>
          )}
        </div>
      </Section>

      {showBlocker && (
        <Section title="Blocked">
          <Banner tone={failureReason === "user_cancelled" ? "attention" : "danger"}>
            <span className="font-semibold">
              {FAILURE_REASON_LABEL[failureReason] ?? failureReason}
            </span>
            {FAILURE_REASON_ACTION[failureReason] && (
              <span className="mt-0.5 block">{FAILURE_REASON_ACTION[failureReason]}</span>
            )}
          </Banner>
        </Section>
      )}

      <Section title="Timing">
        <div className="flex flex-col gap-2.5">
          <Stat icon="calendar" title="Dispatched to a runner">
            {fmtTime(session.dispatchedAt)} dispatched
          </Stat>
          <Stat icon="play" title="Agent started">{fmtTime(session.startedAt)} started</Stat>
          <Stat icon="check" title="Ended (last update on a terminal session)">
            {live ? "—" : fmtTime(session.updatedAt)} ended
          </Stat>
        </div>
      </Section>

      {agentTasks.length > 0 && (
        <Section title={`Agents & tasks · ${agentTasks.length}`}>
          <ul className="flex flex-col gap-1.5">
            {agentTasks.map((t, i) => (
              <li key={`${t.id}-${i}`} className="flex items-center gap-2 overflow-hidden">
                <Icon
                  name={t.tool === "Skill" ? "command" : "agent"}
                  size={13}
                  className="flex-none text-subtle"
                />
                <span className="flex-1 truncate fg-body-sm" title={t.label}>
                  {t.label}
                </span>
                {t.isError && (
                  <Icon name="alert" size={12} className="flex-none" style={{ color: "var(--red-600)" }} />
                )}
                <MonoTag hue={t.tool === "Skill" ? "flame" : "cobalt"}>{t.tool}</MonoTag>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {issueId && siblings.length > 0 && (
        <Section title={`Sessions for this issue · ${siblings.length}`}>
          {/* ISS-378 link-out stub: the session-group / resumed-fresh continuity
              view is owned by ISS-376 and not yet built. Until it lands, this
              existing sibling-session rail IS the "all sessions for this issue"
              surface — do NOT reimplement the resumed/fresh badge here.
              TODO(ISS-376): link each sibling to the session-group timeline. */}
          <ul className="flex flex-col gap-1.5">
            {siblings.map((s) => (
              <SiblingRow
                key={s.id}
                row={s}
                onOpen={
                  projectSlug ? () => router.push(`/projects/${projectSlug}/agents/${s.id}`) : undefined
                }
              />
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Files changed${files.length ? ` · ${files.length}` : ""}`}>
        {files.length === 0 ? (
          <p className="fg-caption">No file edits yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 overflow-hidden">
                <Icon name={f.isNew ? "plus" : "branch"} size={13} className="flex-none text-subtle" />
                <span className="flex-1 truncate font-mono" style={{ fontSize: 11.5 }} title={f.path}>
                  {f.path}
                </span>
                {f.added > 0 && (
                  <span className="flex-none font-mono" style={{ fontSize: 11, color: "var(--green-600)" }}>+{f.added}</span>
                )}
                {f.removed > 0 && (
                  <span className="flex-none font-mono" style={{ fontSize: 11, color: "var(--red-600)" }}>-{f.removed}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** One sibling-session row in "Sessions for this issue" — step label + status
 *  chip, links to its own detail when a project slug is known. */
function SiblingRow({ row, onOpen }: { row: SessionRow; onOpen?: () => void }) {
  const display = deriveSessionDisplayStatus(row);
  const stage = deriveStage(row.metadata);
  const label =
    (row.metadata?.step as string | undefined) ??
    (row.metadata?.stage as string | undefined) ??
    row.title ??
    `Session ${row.id.slice(0, 8)}`;

  const inner = (
    <>
      <Icon name="pipeline" size={13} className="flex-none text-subtle" />
      <span className="flex-1 truncate fg-body-sm capitalize" title={label}>
        {label}
      </span>
      <StatusChip status={statusToChip(display)} stage={stage} size="sm" domain="session" />
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
        className="flex w-full items-center gap-2 overflow-hidden rounded px-1 py-0.5 text-left transition-colors hover:bg-hover focus-visible:outline-none"
      >
        {inner}
      </button>
    </li>
  );
}
