"use client";

import { BulletBar, CardTitle, SectionTitle, Waffle } from "@/design";
import { TONE_META } from "@/design/status";
import { failureReasonLabel } from "@/features/sessions/types";
import { formatElapsed, qualityRates } from "../derive";
import { jobKindLabel } from "../job-kinds";
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
  const { finished, reopened, runFailure, sessionFailures, pipelineFlow } = quality;

  return (
    <section aria-labelledby="overview-quality" className="flex flex-col gap-4 border-t border-line pt-5">
      <SectionTitle id="overview-quality" className="fg-h3">Whether the output holds</SectionTitle>

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
        <CardTitle className="fg-body-sm text-muted">
          Why agent sessions failed — {rates.sessionFailureTotal} in the last 90 days
          {rates.unclassifiedShare !== null
            ? `, ${Math.round(rates.unclassifiedShare * 100)}% unclassified`
            : ""}
        </CardTitle>
        {sessionFailures.length === 0 ? (
          <p className="fg-body-sm text-muted">No failed sessions in the window.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessionFailures.map((r) => (
              <li key={r.reason} className="fg-body-sm flex justify-between gap-2">
                <span className={r.reason === "unclassified" ? "text-subtle" : ""}>
                  {failureReasonLabel(r.reason)}
                </span>
                <span className="tabular-nums text-muted">{r.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <CardTitle id="overview-ran" className="fg-body-sm text-muted">
          What the pipeline actually ran — jobs finished in the last 90 days
        </CardTitle>
        {pipelineFlow.length === 0 ? (
          <p className="fg-body-sm text-muted">No jobs finished in the window.</p>
        ) : (
          <table aria-labelledby="overview-ran" className="w-full">
            <thead>
              <tr className="fg-body-sm text-subtle">
                <th scope="col" className="text-left font-normal">Work</th>
                <th scope="col" className="text-right font-normal">Jobs</th>
                <th scope="col" className="text-right font-normal">Median</th>
              </tr>
            </thead>
            <tbody>
              {pipelineFlow.map((n) => (
                <tr key={n.type} className="fg-body-sm">
                  <td className="py-0.5 text-left">{jobKindLabel(n.type)}</td>
                  <td className="py-0.5 text-right tabular-nums">{n.count}</td>
                  <td className="py-0.5 text-right tabular-nums text-muted">
                    {n.medianSeconds === null ? "—" : formatElapsed(n.medianSeconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
