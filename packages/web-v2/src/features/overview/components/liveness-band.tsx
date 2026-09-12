"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, Heartbeat } from "@/design";
import { formatElapsed, silenceMark } from "../derive";
import type { PulseLiveness, PulseThresholds } from "../types";
import { RecordPanel } from "./record-panel";

const MARK_TEXT: Record<string, string> = {
  calm: "text-muted",
  warn: "text-amber",
  alarm: "text-red",
};

export interface LivenessBandProps {
  liveness: PulseLiveness;
  thresholds: PulseThresholds;
}

/** Section 1 — is the control plane executing? */
// cm:guard the heartbeat renders on series LENGTH, never on a value in it — an all-zero window is a flatline and the single most important thing this surface says; a `some(v > 0)` test here hides three silent days behind an empty frame (ISS-988 criteria 26, 48).
export function LivenessBand({ liveness, thresholds }: LivenessBandProps) {
  const [panel, setPanel] = useState<"liveJobs" | "stuckRuns" | null>(null);
  const mark = silenceMark(liveness.silenceSeconds, thresholds);
  const live = liveness.jobsRunning + liveness.jobsQueued + liveness.jobsHeld;

  const silenceText =
    liveness.silenceSeconds === null
      ? "No job has ever run here"
      : `Silent for ${formatElapsed(liveness.silenceSeconds)}`;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="fg-h3">Is it alive?</h2>
          <p className={`fg-body-sm ${MARK_TEXT[mark]}`}>
            {silenceText}
            {mark === "alarm" ? " — past the alarm mark" : null}
            {mark === "warn" ? " — past the first mark" : null}
          </p>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <button
            type="button"
            onClick={() => setPanel(panel === "liveJobs" ? null : "liveJobs")}
            aria-label={`${live} live jobs — open the list`}
            className="rounded-sm px-1 py-0.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <span className="fg-h2 block tabular-nums">{live}</span>
            <span className="fg-body-sm text-muted">
              live jobs · {liveness.jobsRunning} running · {liveness.jobsQueued} queued ·{" "}
              {liveness.jobsHeld} held
            </span>
          </button>

          <button
            type="button"
            onClick={() => setPanel(panel === "stuckRuns" ? null : "stuckRuns")}
            aria-label={`${liveness.stuckRuns.total} runs claimed but empty — open the list`}
            className="rounded-sm px-1 py-0.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <span className="fg-h2 block tabular-nums">{liveness.stuckRuns.total}</span>
            <span className="fg-body-sm text-muted">runs claimed, nothing under them</span>
          </button>

          <Link
            href="/runners"
            aria-label={`${liveness.devices.online} of ${liveness.devices.total} runners online — open Runners`}
            className="rounded-sm px-1 py-0.5 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <span className="fg-h2 block tabular-nums">
              {liveness.devices.online}/{liveness.devices.total}
            </span>
            <span className="fg-body-sm text-muted">
              runners online
              {liveness.devices.draining > 0 ? ` · ${liveness.devices.draining} draining` : ""}
            </span>
          </Link>
        </div>

        {liveness.heartbeat.length > 0 ? (
          <Heartbeat
            days={liveness.heartbeat.map((d) => ({ date: d.date, value: d.issueRuns }))}
            label={`Issue runs started each day for the last ${liveness.heartbeat.length} days. ${
              liveness.heartbeat.every((d) => d.issueRuns === 0)
                ? "Nothing ran on any of them."
                : `Busiest day: ${Math.max(...liveness.heartbeat.map((d) => d.issueRuns))} runs.`
            }`}
          />
        ) : (
          <p className="fg-body-sm text-muted">
            No heartbeat series in this response. {live} live jobs, {liveness.stuckRuns.total} runs
            claimed but empty.
          </p>
        )}

        {panel === "liveJobs" ? (
          <RecordPanel
            title="Live jobs"
            total={liveness.liveJobs.total}
            records={liveness.liveJobs.shown.map((j) => ({
              key: j.jobId,
              label: j.issueRef ?? j.type,
              detail: `${j.type} · ${j.projectSlug}`,
              href: j.issueDocId
                ? `/projects/${j.projectSlug}/issues/${j.issueDocId}`
                : `/ops?run=${j.runId}`,
              ageSeconds: j.ageSeconds,
            }))}
            onClose={() => setPanel(null)}
          />
        ) : null}
        {panel === "stuckRuns" ? (
          <RecordPanel
            title="Runs claimed but empty"
            total={liveness.stuckRuns.total}
            records={liveness.stuckRuns.shown.map((r) => ({
              key: r.runId,
              label: r.issueRef ?? "Run",
              detail: r.projectSlug,
              href: r.issueDocId
                ? `/projects/${r.projectSlug}/issues/${r.issueDocId}`
                : `/ops?run=${r.runId}`,
              ageSeconds: r.ageSeconds,
            }))}
            onClose={() => setPanel(null)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
