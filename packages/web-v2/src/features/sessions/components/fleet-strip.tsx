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
          <span className="font-semibold">Dispatch stalled — no runner online.</span>{" "}
          {queuedCount} session{queuedCount === 1 ? "" : "s"} queued with no runner to pick it up.
          Bring a runner online or check device pairing.
        </Banner>
      )}

      {projectQ.isError ? (
        <ErrorState
          title="Couldn't load the runner pool"
          message={formatApiError(projectQ.error)}
          onRetry={() => projectQ.refetch()}
        />
      ) : !projectQ.isSuccess ? null : devicePool.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-4 py-3 fg-body-sm text-muted">
          No runners paired to this project yet.
        </div>
      ) : (
        <div className="flex gap-2.5 overflow-x-auto pb-1">
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
                className="min-w-[200px] flex-none rounded-lg border border-line bg-surface px-3 py-2.5"
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
                  <span className="fg-caption text-subtle">{enumLabel("platform", d.platform)}</span>
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <span
                    className="fg-caption font-semibold"
                    style={{ color: busy ? "var(--cobalt-700)" : "var(--fg-subtle)" }}
                  >
                    {busy ? "Busy · 1/1" : "Free · 0/1"}
                  </span>
                  <span className="fg-caption text-subtle" title={`${queued} queued behind this runner`}>
                    {queued > 0 ? `${queued} queued` : "no queue"}
                  </span>
                </div>

                {busy && (step || issueRef || stale) && (
                  <div className="mt-1.5 flex items-center gap-1.5 overflow-hidden">
                    {step && <span className="fg-caption text-muted">{enumLabel("jobType", step)}</span>}
                    {issueRef && (
                      <>
                        {step && <span className="fg-caption text-subtle">·</span>}
                        <MonoTag hue="cobalt">{issueRef}</MonoTag>
                      </>
                    )}
                    {stale && (
                      <span className="fg-caption" style={{ color: "var(--amberw-600)" }}>
                        stalled
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
