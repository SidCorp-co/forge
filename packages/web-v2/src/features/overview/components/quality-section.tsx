"use client";

import { BulletBar, Card, CardContent, SankeyFlow, Waffle } from "@/design";
import { TONE_META } from "@/design/status";
import { formatElapsed, qualityRates } from "../derive";
import type { PulseQuality } from "../types";

const LANE_LABEL: Record<string, string> = {
  pipeline: "Pipeline runs",
  scheduler: "Scheduler runs",
  other: "Everything else",
};

export interface QualitySectionProps {
  quality: PulseQuality;
}

/** Section 5 — is the output any good? */
export function QualitySection({ quality }: QualitySectionProps) {
  const rates = qualityRates(quality);
  const { finished, reopened, rework, runFailure, sessionFailures, pipelineFlow } = quality;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <h2 className="fg-h3">Whether the output holds</h2>

        {rates.finishedTotal > 0 ? (
          <Waffle
            categories={[
              {
                key: "merged",
                label: "Closed with a merge",
                count: finished.merged,
                color: TONE_META.success.dot,
              },
              {
                key: "closedUnmerged",
                label: "Closed with no merge",
                count: finished.closedUnmerged,
                color: TONE_META.attention.dot,
              },
              {
                key: "dropped",
                label: "Dropped",
                count: finished.dropped,
                color: TONE_META.archived.dot,
              },
            ]}
          />
        ) : (
          <p className="fg-body-sm text-muted">Nothing has finished in scope yet.</p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <BulletBar
            label="Closed with merge evidence"
            value={finished.merged}
            total={rates.finishedTotal}
            valueText={`${finished.merged} of ${rates.finishedTotal}`}
          />
          <BulletBar
            label="Issues reopened"
            value={reopened.issues}
            total={rates.finishedTotal}
            valueText={`${reopened.issues} issues · ${reopened.events} reopenings`}
          />
          <BulletBar
            label="Fix jobs against code jobs"
            value={rework.fix}
            total={rework.code}
            valueText={
              rates.reworkRatio === null
                ? `${rework.fix} fix · no code jobs`
                : `${rework.fix} fix · ${rework.code} code`
            }
          />
          {(["pipeline", "scheduler", "other"] as const).map((lane) => (
            <BulletBar
              key={lane}
              label={`${LANE_LABEL[lane]} failed`}
              value={runFailure[lane].failed}
              total={runFailure[lane].total}
            />
          ))}
        </div>

        <div className="flex flex-col gap-1">
          <h3 className="fg-body-sm text-muted">
            Why agent sessions failed — {rates.sessionFailureTotal} in 90 days
            {rates.unclassifiedShare !== null
              ? `, ${Math.round(rates.unclassifiedShare * 100)}% unclassified`
              : ""}
          </h3>
          {sessionFailures.length === 0 ? (
            <p className="fg-body-sm text-muted">No failed sessions in the window.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sessionFailures.map((r) => (
                <li key={r.reason} className="fg-body-sm flex justify-between gap-2">
                  <span className={r.reason === "unclassified" ? "text-subtle" : ""}>
                    {r.reason}
                  </span>
                  <span className="tabular-nums text-muted">{r.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <h3 className="fg-body-sm text-muted">What the pipeline actually ran</h3>
          {pipelineFlow.length === 0 ? (
            <p className="fg-body-sm text-muted">No jobs finished in the window.</p>
          ) : (
            <SankeyFlow
              nodes={pipelineFlow.map((n) => ({
                key: n.type,
                label: n.type,
                count: n.count,
                medianSeconds: n.medianSeconds,
                loop: n.type === "fix",
              }))}
              formatDuration={(s) => (s === null ? "—" : formatElapsed(s))}
              label={`Jobs by pipeline stage over 90 days. ${pipelineFlow
                .map((n) => `${n.type}: ${n.count}`)
                .join(", ")}.`}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
