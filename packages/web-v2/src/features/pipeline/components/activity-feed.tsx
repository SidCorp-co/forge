"use client";

// The run/job Activity Feed (ISS-885) — the History tab of RunDetail.
//
// Reads the run's `attempts[]` and renders the lifecycle record: Verb · Object ·
// Outcome per line, failures first-class, silence and queueing rendered rather
// than left blank. There is deliberately NO input, no reply, nothing typeable:
// VISION §5 is that the primary surface is an auditable lifecycle, not a
// conversation, and a text box here would make it the thing §5 forbids.
//
// Grouping + labels are pure and live in `../activity`; this file is render only.

import { useState } from "react";
import {
  Badge,
  EmptyState,
  ErrorState,
  Icon,
  SegmentedControl,
  Skeleton,
  Tooltip,
} from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { formatApiError } from "@/lib/api/error";
import {
  type ActivityEntry,
  type ActivityFilter,
  type ActivityTone,
  deriveActivityFeed,
  distinctCauseCount,
  filterActivity,
} from "../activity";
import type { PipelineRunRetrySummary, PipelineRunSummary } from "../types";

interface ActivityTabProps {
  run: PipelineRunSummary | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}

const TONE_CLASS: Record<ActivityTone, { dot: string; fg: string }> = {
  failure: { dot: "bg-danger-9", fg: "text-danger-11" },
  swept: { dot: "bg-neutral-8", fg: "text-muted" },
  cleanup: { dot: "bg-neutral-8", fg: "text-muted" },
  success: { dot: "bg-ok-9", fg: "text-ok-11" },
  open: { dot: "bg-info-9", fg: "text-info-11" },
};

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "failures", label: "Failures" },
];

export function ActivityTab({ run, loading, error, onRetry }: ActivityTabProps) {
  const [filter, setFilter] = useState<ActivityFilter>("all");

  if (loading) return <ActivitySkeleton />;
  if (error) return <ErrorState message={formatApiError(error)} onRetry={onRetry} />;

  // This tab reads a pipeline run's attempts; a session that ran outside one is not "nothing".
  if (!run) {
    return (
      <EmptyState
        title="No pipeline run"
        message="This tab lists a pipeline run's attempts, and this issue has no pipeline run."
      />
    );
  }

  const entries = deriveActivityFeed(run.attempts);
  if (entries.length === 0) {
    return (
      <EmptyState
        title="Nothing has run yet"
        message="Attempts appear here the moment a runner picks this up."
      />
    );
  }

  const visible = filterActivity(entries, filter);
  const causes = distinctCauseCount(entries);
  const failures = filterActivity(entries, "failures").length;

  return (
    <div className="flex flex-col gap-4">
      {run?.retrySummary && <RetryHeadline summary={run.retrySummary} />}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="fg-overline">Activity</p>
        {failures > 0 && (
          <span className="fg-caption text-muted">
            {causes === 1
              ? "every failure here has one cause"
              : `${causes} distinct causes across ${failures} failed line${failures === 1 ? "" : "s"}`}
          </span>
        )}
        <span className="ml-auto">
          <SegmentedControl options={FILTERS} value={filter} onChange={setFilter} />
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          mascot={false}
          title="No failures"
          message="Nothing on this run failed. Switch back to All to see every attempt."
          action={{ label: "Show all", onClick: () => setFilter("all") }}
        />
      ) : (
        <ol className="flex list-none flex-col divide-y divide-line-subtle p-0">
          {visible.map((entry) => (
            <ActivityLine key={entry.key} entry={entry} />
          ))}
        </ol>
      )}
    </div>
  );
}

function RetryHeadline({ summary }: { summary: PipelineRunRetrySummary }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line-subtle pb-2.5">
      <span
        className="rounded-pill bg-warn-3 px-2 py-0.5 font-mono text-12 font-semibold text-warn-11"
      >
        attempt {summary.attempt}/{summary.maxAttempts}
      </span>
      <span className="fg-caption ml-auto text-subtle">{summary.totalAttempts} attempts</span>
    </div>
  );
}

/** The one sentence that says WHICH attempts a collapsed line stands for. */
function repeatLabel(positions: number[]): string {
  return `Attempts ${positions.join(", ")} were identical.`;
}

function ActivityLine({ entry }: { entry: ActivityEntry }) {
  const tone = TONE_CLASS[entry.tone];
  const when = formatRelativeTime(entry.at);
  return (
    <li className="flex gap-3 py-3">
      <span
        aria-hidden
        className={cn("mt-1.5 size-2 flex-none rounded-full", tone.dot, entry.open && "forge-pulse")}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="fg-body-sm font-semibold text-fg">{entry.verb}</span>
          <span className="font-mono text-13 font-bold text-muted">{entry.object}</span>
          <span className={cn("fg-body-sm font-semibold", tone.fg)}>
            {entry.outcome}
          </span>
          {entry.repeats > 1 && (
            <Tooltip label={repeatLabel(entry.positions)}>
              <span className="inline-flex">
                <Badge tone={entry.tone === "failure" ? "red" : "neutral"}>
                  ×{entry.repeats}
                </Badge>
                <span className="sr-only">{repeatLabel(entry.positions)}</span>
              </span>
            </Tooltip>
          )}
        </div>

        {entry.detail && (
          <p className="fg-caption break-words text-muted">{entry.detail}</p>
        )}
        {entry.action && (
          <p className="fg-caption break-words text-warn-11">
            {entry.action}
          </p>
        )}

        <div className="fg-caption flex flex-wrap items-center gap-x-3 gap-y-1 text-subtle">
          <span className="inline-flex min-w-0 items-center gap-1">
            <Icon name="server" size={11} className="flex-none" />
            <span className="truncate">{entry.device}</span>
          </span>
          {when && <span>{when}</span>}
        </div>
      </div>
    </li>
  );
}

function ActivitySkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      <Skeleton variant="text" className="w-30" />
      <Skeleton className="h-19.5" />
      <Skeleton className="h-19.5" />
      <Skeleton className="h-19.5" />
    </div>
  );
}
