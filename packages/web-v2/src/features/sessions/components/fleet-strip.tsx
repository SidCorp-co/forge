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
// Data: `useRunnerFleet`, the one summary the dashboard's Sessions live caption and Runners card
// read too, so the strip and the dashboard never disagree about which boxes are online or busy
// (ISS-1228); the project's defaultDeviceId; and the listed rows for the step a busy box is on.
// Liveness is the shared deriveLiveness threshold so the strip, list, and detail never diverge.
import { useMemo } from "react";
import { Banner, HealthDot, Icon, MonoTag, SILENCE_TONE, SILENCE_WORD, Tooltip } from "@/design";
import { TONE_META } from "@/design/status";
import type { RunnerLine } from "@/features/project-dashboard/derive";
import { useRunnerFleet } from "@/features/project-dashboard/runner-fleet";
import { plural, type ReadState } from "@/features/project-dashboard/shape";
import { useProject } from "@/features/projects/hooks";
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

/** A box's state in words: busy and free are said only of a box online, as the dashboard counts them. */
function boxWord(line: RunnerLine, activityRead: boolean): string {
  const hosting = line.sessions > 0 ? ` · ${plural(line.sessions, "live session", "live sessions")}` : "";
  if (line.draining) return `Draining${hosting}`;
  if (!line.online) return `Offline${hosting}`;
  if (!activityRead) return "activity not read";
  return line.busy ? "Busy · 1/1" : "Free · 0/1";
}

function queueWord(queued: number, read: ReadState): string {
  if (read.read === "failed") return "queue not read";
  if (read.read === "pending") return "reading the queue";
  return queued > 0 ? `${queued} queued` : "no queue";
}

export function FleetStrip({ projectId, rows, displays, now }: FleetStripProps) {
  const projectQ = useProject(projectId);
  const fleet = useRunnerFleet(projectId, now);
  const lines = fleet.summary.lines;
  const defaultDeviceId = projectQ.data?.defaultDeviceId ?? null;
  const activityRead = fleet.activity.read === "ok";

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

  const queuedCount = rows.filter((r) => r.status === "queued" || r.status === "idle").length;
  const dispatchStalled =
    fleet.runners.read === "ok" && queuedCount > 0 && fleet.summary.onlineCount === 0;

  return (
    <div className="flex flex-col gap-3">
      {dispatchStalled && (
        <Banner tone="danger">
          <span className="font-semibold">Dispatch stalled — no runner online.</span>{" "}
          {queuedCount} session{queuedCount === 1 ? "" : "s"} queued with no runner to pick it up.
          Bring a runner online or check device pairing.
        </Banner>
      )}

      {fleet.runners.read !== "ok" ? (
        <p className="fg-body-sm border-y border-line py-3 text-muted">
          {fleet.runners.read === "failed" ? `Runners not read: ${fleet.runners.reason}` : "Reading runners…"}
        </p>
      ) : lines.length === 0 ? (
        <p className="fg-body-sm border-y border-line py-3 text-muted">No runners paired to this project yet.</p>
      ) : (
        <ul aria-label="Boxes" className="flex flex-col divide-y divide-line border-y border-line">
          {lines.map((d) => {
            const bound = d.deviceId ? boundByDevice.get(d.deviceId) : undefined;
            const busy = d.online && d.busy;
            const liveness = bound ? deriveLiveness(bound.row, now) : null;
            const stale = liveness?.state === "stale" || liveness?.state === "reaping";
            const health = d.online ? (busy && stale ? "attention" : "healthy") : d.sessions > 0 ? "attention" : "idle";
            const isPrimary = d.deviceId !== null && d.deviceId === defaultDeviceId;
            const queued = d.queued;
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
                    data-testid="box-word"
                    className="fg-caption font-semibold"
                    style={{ color: busy ? "var(--cobalt-700)" : "var(--fg-subtle)" }}
                  >
                    {boxWord(d, activityRead)}
                  </span>
                  <span data-testid="box-queue" className="fg-caption text-subtle" title={`${queued} queued behind this runner`}>
                    {queueWord(queued, fleet.queue)}
                  </span>
                </div>

                {bound && (step || issueRef || stale) && (
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
