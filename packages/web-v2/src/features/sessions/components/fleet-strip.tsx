"use client";

// Fleet-runner rollup strip (ISS-378 A/B). Turns the flat counters into a
// per-runner operator view: one chip per device in the project pool showing
// online/offline/stale health, busy/free slot (runner cap = 1), queue depth,
// and the current step · ISS-x it is running. Primary (defaultDeviceId) vs
// cold-spare devices are visually distinguished so an idle spare doesn't read
// as broken. A "dispatch stalled — no runner online" banner appears only when
// work is queued AND zero runners are online (the silent no_worker_online mode)
// — never when runners are merely all-busy (healthy backpressure).
//
// Data: useProject(projectId).devicePool + defaultDeviceId (project-scoped) ×
// useQueueStats(projectId) (per-device queued/running). Liveness is the shared
// deriveLiveness threshold so the strip, list, and detail never diverge.
import { useMemo } from "react";
import { Banner, HealthDot, Icon, MonoTag, SILENCE_TONE, SILENCE_WORD, Tooltip } from "@/design";
import { TONE_META } from "@/design/status";
import { useProject } from "@/features/projects/hooks";
import { deviceHealth } from "@/features/runners/types";
import { useQueueStats } from "../hooks";
import {
  deriveLiveness,
  isLiveDisplay,
  sessionStep,
  type AgentSessionDisplayStatus,
  type SessionRow,
} from "../types";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

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
}

export function FleetStrip({ projectId, rows, displays, now }: FleetStripProps) {
  const projectQ = useProject(projectId);
  const queueQ = useQueueStats(projectId);

  const devicePool = projectQ.data?.devicePool ?? [];
  const defaultDeviceId = projectQ.data?.defaultDeviceId ?? null;

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
      if (isLiveDisplay(d) && row.deviceId && !m.has(row.deviceId)) {
        m.set(row.deviceId, { row, display: d });
      }
    });
    return m;
  }, [rows, displays]);

  const onlineRunners = devicePool.filter((d) => d.status === "online").length;
  const queuedCount = rows.filter((r) => r.status === "queued" || r.status === "idle").length;
  const dispatchStalled = queuedCount > 0 && onlineRunners === 0;

  return (
    <div className="flex flex-col gap-3">
      {dispatchStalled && (
        <Banner tone="danger">
          <span className="font-semibold">Dispatch stalled — no runner online.</span>{" "}
          {queuedCount} session{queuedCount === 1 ? "" : "s"} queued with no runner to pick it up.
          Bring a runner online or check device pairing.
        </Banner>
      )}

      {devicePool.length === 0 ? (
        <p className="fg-body-sm border-y border-line py-3 text-muted">No runners paired to this project yet.</p>
      ) : (
        <ul aria-label="Boxes" className="flex flex-col divide-y divide-line border-y border-line">
          {devicePool.map((d) => {
            const bound = boundByDevice.get(d.id);
            const busy = !!bound;
            const liveness = bound ? deriveLiveness(bound.row, now) : null;
            const stale = liveness?.state === "stale" || liveness?.state === "reaping";
            const health = busy && stale ? "attention" : deviceHealth(d.status as never);
            const isPrimary = d.id === defaultDeviceId;
            const queued = queuedByDevice.get(d.id) ?? 0;
            const step = bound ? sessionStep(bound.row.metadata) : null;
            const issueRef = bound ? issueRefFromTitle(bound.row.title) : null;

            return (
              <li
                key={d.id}
                className="flex flex-col gap-1 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4"
              >
                <div className="flex min-w-0 items-center gap-1.5 sm:w-56">
                  <HealthDot health={health} withLabel={false} />
                  <Icon name="server" size={13} className="flex-none text-subtle" />
                  <span className="truncate fg-body-sm font-medium text-fg" title={d.name}>
                    {d.name}
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <Tooltip label={isPrimary ? "Primary runner (pinned default)" : "Cold spare — idle is normal"}>
                    <MonoTag hue={isPrimary ? "cobalt" : "neutral"}>
                      {isPrimary ? "Primary" : "Spare"}
                    </MonoTag>
                  </Tooltip>
                  <span className="fg-caption text-subtle">
                    {PLATFORM_LABEL[d.platform] ?? d.platform}
                  </span>
                </div>

                <div className="flex items-center gap-3">
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
                  <div className="flex items-center gap-1.5 overflow-hidden">
                    {step && <span className="fg-caption capitalize text-muted">{step}</span>}
                    {issueRef && (
                      <>
                        {step && <span className="fg-caption text-subtle">·</span>}
                        <MonoTag hue="cobalt">{issueRef}</MonoTag>
                      </>
                    )}
                    {stale && (
                      <span className="fg-caption" style={{ color: TONE_META[SILENCE_TONE].fg }}>
                        {SILENCE_WORD}
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
