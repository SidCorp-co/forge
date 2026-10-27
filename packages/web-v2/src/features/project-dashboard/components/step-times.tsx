"use client";

// The project dashboard's "Where time goes" tile: the median and the cost of each job type over the
// step-durations window, slowest median first. Both figures come from the same rows the spend tile
// reads, folded onto the job type each row carries.

import { jobKindLabel } from "@/features/overview/job-kinds";
import { useMemo } from "react";
import { ErrorState } from "@/design";
import { aggregateStepCosts } from "@/features/runs/derive";
import { formatDurationSec, formatUsd } from "@/lib/utils/format";
import type { StepDurationRow } from "@/features/runs/types";
import { formatApiError } from "@/lib/api/error";
import { slowestComparison } from "../shape";
import { DashboardSection, EmptyLine, unreadSection } from "./dashboard-section";

interface StepTimesProps {
  durations: StepDurationRow[] | undefined;
  windowDays: number;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}

export function StepTimes({ durations, windowDays, isLoading, error, onRetry }: StepTimesProps) {
  const steps = useMemo(() => aggregateStepCosts(durations), [durations]);
  const maxMedian = Math.max(1, ...steps.map((s) => s.medianSec));
  const slowest = steps[0] ?? null;
  const versus = slowestComparison(steps);
  const samples = durations?.length ?? 0;

  // A read that has not arrived says so by name; it is neither an empty window nor a skeleton.
  if (!error && isLoading) return unreadSection("Where time goes", "The step times", { read: "pending" }, true);

  if (!error && slowest == null) {
    return <EmptyLine title="Where time goes" status={`no agent step finished in ${windowDays} days`} />;
  }

  return (
    <DashboardSection
      title="Where time goes"
      aside={
        !error ? (
          <>
            {steps.length} step{steps.length === 1 ? "" : "s"} · {samples} finished · {windowDays}d
          </>
        ) : undefined
      }
    >
      {error ? (
        <ErrorState
          title="Couldn't load step times"
          message={formatApiError(error)}
          error={error} onRetry={onRetry}
          mascot={false}
        />
      ) : slowest === null ? null : (
        <>
          <div className="flex flex-col gap-2.5">
            {steps.map((s) => (
              <div key={s.step} className="flex items-center gap-2.5">
                <span data-step-label className="w-28 flex-none break-words text-12 text-muted" title={jobKindLabel(s.step)}>
                  {jobKindLabel(s.step)}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${(s.medianSec / maxMedian) * 100}%`, background: "var(--fg-muted)" }}
                  />
                </span>
                <span className="w-14 flex-none text-right font-mono text-12 text-fg">
                  {formatDurationSec(s.medianSec)}
                </span>
                <span className="w-14 flex-none text-right font-mono text-12 text-muted">
                  {formatUsd(s.cost)}
                </span>
              </div>
            ))}
          </div>
          <p className="fg-body-sm mt-3 border-t border-line-subtle pt-2 text-muted">
            Slowest step: <span className="text-fg">{jobKindLabel(slowest.step)}</span> at a{" "}
            <span className="font-mono text-fg">{formatDurationSec(slowest.medianSec)}</span> median
            over {slowest.samples} run{slowest.samples === 1 ? "" : "s"}
            {versus ? (
              <>
                , <span className="font-mono text-fg">{versus.ratio.toFixed(1)}×</span> slower than{" "}
                <span className="text-fg">{jobKindLabel(versus.next)}</span>
              </>
            ) : null}
            .
          </p>
        </>
      )}
    </DashboardSection>
  );
}
