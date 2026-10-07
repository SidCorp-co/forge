"use client";

// Fleet-runner rollup strip (ISS-378 A/B). Turns the flat counters into a
// per-runner operator view: one chip per device in the project pool showing
// online/offline/stale health, busy/free slot (runner cap = 1), queue depth,
// and the current step · ISS-x it is running. A "dispatch stalled — no runner online" banner appears only when
// work is queued AND zero runners are online (the silent no_worker_online mode)
// — never when runners are merely all-busy (healthy backpressure).
//
// Data: useProject(projectId).devicePool (project-scoped) ×
// useQueueStats(projectId) (per-device queued/running). Liveness reads core's stuck runs
// (runs/standing) through deriveLiveness so the strip, list, and detail never diverge.
import { useMemo } from "react";
import { Banner, enumLabel, ErrorState, HealthDot, Icon, MonoTag } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { useProject } from "@/features/projects/hooks";
import { deviceHealth } from "@/features/runners/types";
import { useQueueStats } from "../hooks";
import {
  deriveLiveness,
  sessionStep,
  type AgentSessionDisplayStatus,
  type SessionRow,
  type StuckRuns,
} from "../types";

/** Pull a friendly `ISS-<seq>` token from a session title (the session row only
 *  carries the issue UUID, but titles are stamped `ISS-<seq> <title>`). */
function issueRefFromTitle(title: string | null): string | null {
  if (!title) return null;
  const m = title.match(/ISS-\d+/i);
  return m ? m[0].toUpperCase() : null;
}

interface FleetStripProps {
  projectId: string;
  /** Rows + their derived display status, computed once by the parent so the
   *  strip and list agree on what counts as running/stalled. */
  rows: SessionRow[];
  displays: AgentSessionDisplayStatus[];
  now: number;
  stuck: StuckRuns;
}

export function FleetStrip({ projectId, rows, displays, now, stuck }: FleetStripProps) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const projectQ = useProject(projectId);
  const queueQ = useQueueStats(projectId);

  const devicePool = projectQ.data?.devicePool ?? [];

  // Per-device queue depth from queue-stats (queued sessions waiting on that
  // device). Sessions with no device assigned bucket under the null key.
  const queuedByDevice = useMemo(() => {
    const m = new Map<string | null, number>();
    for (const d of queueQ.data?.devices ?? []) m.set(d.deviceId, d.queued);
    return m;
  }, [queueQ.data]);

  const boundByDevice = useMemo(() => {
    const m = new Map<string, { row: SessionRow; display: AgentSessionDisplayStatus }>();
    rows.forEach((row, i) => {
      const d = displays[i];
      if ((d === "running" || d === "stalled") && row.deviceId && !m.has(row.deviceId)) {
        m.set(row.deviceId, { row, display: d });
      }
    });
    return m;
  }, [rows, displays]);

  const onlineRunners = devicePool.filter((d) => d.status === "online").length;
  const queuedCount = rows.filter((r) => r.status === "queued" || r.status === "idle").length;
  // Zero online runners is read only off a loaded pool: a pending or failed read is not an empty fleet.
  const dispatchStalled = projectQ.isSuccess && queuedCount > 0 && onlineRunners === 0;

  return (
    <div className="flex flex-col gap-3">
      {dispatchStalled && (
        <Banner tone="danger">
          <span className="font-semibold">{t("sessions.fleet.stalledTitle")}</span>{" "}
          {queuedCount === 1 ? t("sessions.fleet.stalledBodyOne") : t("sessions.fleet.stalledBody", { count: time.number(queuedCount) })}
        </Banner>
      )}

      {projectQ.isError ? (
        <ErrorState
          title={t("sessions.fleet.poolFailed")}
          message={formatApiError(projectQ.error)}
          onRetry={() => projectQ.refetch()}
        />
      ) : !projectQ.isSuccess ? null : devicePool.length === 0 ? (
        <div className="py-3 fg-body-sm text-muted">
          {t("sessions.fleet.empty")}
        </div>
      ) : (
        <div className="flex divide-x divide-line-subtle overflow-x-auto pb-1">
          {devicePool.map((d) => {
            const bound = boundByDevice.get(d.id);
            const busy = !!bound;
            const liveness = bound ? deriveLiveness(bound.row, stuck, now) : null;
            const stale = liveness?.state === "stale" || liveness?.state === "reaping";
            const health = busy && stale ? "attention" : deviceHealth(d.status as never);
            const queued = queuedByDevice.get(d.id) ?? 0;
            const step = bound ? sessionStep(bound.row.metadata) : null;
            const issueRef = bound ? issueRefFromTitle(bound.row.title) : null;

            return (
              <div
                key={d.id}
                className="min-w-[200px] flex-none px-4 py-1 first:pl-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Icon name="server" size={13} className="flex-none text-subtle" />
                    <span className="truncate fg-body-sm text-fg" title={d.name}>
                      {d.name}
                    </span>
                  </div>
                  <HealthDot health={health} withLabel={false} />
                </div>

                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="fg-caption text-subtle">{enumLabel("platform", d.platform, language)}</span>
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <span
                    className="fg-caption font-semibold"
                    style={{ color: busy ? "var(--cobalt-700)" : "var(--fg-subtle)" }}
                  >
                    {busy ? t("sessions.fleet.busy") : t("sessions.fleet.free")}
                  </span>
                  <span className="fg-caption text-subtle" title={t("sessions.fleet.queuedBehind", { n: time.number(queued) })}>
                    {queued > 0 ? t("sessions.fleet.queued", { n: time.number(queued) }) : t("sessions.fleet.noQueue")}
                  </span>
                </div>

                {busy && (step || issueRef || stale) && (
                  <div className="mt-1.5 flex items-center gap-1.5 overflow-hidden">
                    {step && <span className="fg-caption text-muted">{enumLabel("jobType", step, language)}</span>}
                    {issueRef && (
                      <>
                        {step && <span className="fg-caption text-subtle">·</span>}
                        <MonoTag hue="cobalt">{issueRef}</MonoTag>
                      </>
                    )}
                    {stale && (
                      <span className="fg-caption" style={{ color: "var(--amberw-600)" }}>
                        {t("sessions.fleet.stalled")}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
