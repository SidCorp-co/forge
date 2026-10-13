"use client";

// The project dashboard's "Where time goes" tile: the median and the cost of each job type over the
// step-durations window, slowest median first. Both figures come from the same rows the spend tile
// reads, folded onto the job type each row carries.

import { useMemo } from "react";
import { Card, CardContent, CardTitle, EmptyState, ErrorState, Icon, Skeleton } from "@/design";
import { aggregateStepCosts, formatDurationSec, formatUsd } from "@/features/pipeline/derive";
import type { StepDurationRow } from "@/features/pipeline/types";
import { formatApiError } from "@/lib/api/error";

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
  const samples = durations?.length ?? 0;

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="clock" size={16} className="text-subtle" />
          <CardTitle>Where time goes</CardTitle>
        </div>
        {!error && !isLoading && (
          <span className="fg-caption text-subtle">
            {samples} step{samples === 1 ? "" : "s"} · {windowDays}d
          </span>
        )}
      </div>
      <CardContent className="flex-1">
        {error ? (
          <ErrorState
            title="Couldn't load step times"
            message={formatApiError(error)}
            onRetry={onRetry}
            mascot={false}
          />
        ) : isLoading ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : slowest == null ? (
          <EmptyState
            title="No steps yet"
            message={`No agent step finished in the last ${windowDays} days.`}
            mascot={false}
          />
        ) : (
          <>
            <div className="flex flex-col gap-2.5">
              {steps.map((s) => (
                <div key={s.step} className="flex items-center gap-2.5">
                  <span
                    className="max-w-[96px] flex-none truncate font-mono text-12 lowercase text-muted"
                    title={s.step}
                  >
                    {s.step}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                    <span
                      className="block h-full rounded-full"
                      style={{ width: `${(s.medianSec / maxMedian) * 100}%`, background: s.color }}
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
            <p className="fg-body-sm mt-4 border-t border-line pt-3 text-muted">
              Slowest step: <span className="font-mono lowercase text-fg">{slowest.step}</span> at a{" "}
              <span className="font-mono text-fg">{formatDurationSec(slowest.medianSec)}</span> median
              over {slowest.samples} run{slowest.samples === 1 ? "" : "s"}.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
