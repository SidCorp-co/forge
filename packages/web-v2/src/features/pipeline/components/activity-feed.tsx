"use client";

// The run/job Activity Feed (ISS-885) — the Activity tab of RunDetail.
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

// cm:guard `failure` is the ONLY red — ISS-322 settled that a cascade cleanup and a lifecycle sweep must not read like a step that broke, and re-pointing any other tone at `--red-*` here silently re-opens that
const TONE_COLOR: Record<ActivityTone, { dot: string; fg: string }> = {
  failure: { dot: "var(--red-500)", fg: "var(--red-600)" },
  swept: { dot: "var(--ink-400)", fg: "var(--fg-muted)" },
  cleanup: { dot: "var(--ink-400)", fg: "var(--fg-muted)" },
  success: { dot: "var(--green-500)", fg: "var(--green-600)" },
  open: { dot: "var(--pipeline-active)", fg: "var(--cobalt-700)" },
};

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "failures", label: "Failures" },
];

export function ActivityTab({ run, loading, error, onRetry }: ActivityTabProps) {
  const [filter, setFilter] = useState<ActivityFilter>("all");

  if (loading) return <ActivitySkeleton />;
  if (error) return <ErrorState message={formatApiError(error)} onRetry={onRetry} />;

  const entries = deriveActivityFeed(run?.attempts);
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
        <ol className="flex list-none flex-col gap-2.5 p-0">
          {visible.map((entry) => (
            <ActivityRow key={entry.key} entry={entry} />
          ))}
        </ol>
      )}
    </div>
  );
}

// cm:guard ISS-411's round-robin headline moved here when the retry list folded into this feed — deleting it drops WHERE the next attempt will land, which no other surface in web-v2 shows
function RetryHeadline({ summary }: { summary: PipelineRunRetrySummary }) {
  const target = summary.targetDeviceName ?? summary.targetDeviceId?.slice(0, 8) ?? null;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-line-subtle bg-sunken px-3.5 py-2.5">
      <span
        className="rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold"
        style={{ background: "var(--amberw-50)", color: "var(--amberw-600)" }}
      >
        round {summary.round}/{summary.maxRounds}
      </span>
      {target && (
        <span className="fg-caption inline-flex min-w-0 items-center gap-1 text-muted">
          <Icon name="server" size={11} className="flex-none align-[-1px]" />
          <span className="truncate">targeting {target}</span>
        </span>
      )}
      <span className="fg-caption ml-auto text-subtle">{summary.totalAttempts} attempts</span>
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const color = TONE_COLOR[entry.tone];
  const when = formatRelativeTime(entry.at);
  return (
    <li className="flex gap-3 rounded-md border border-line-subtle bg-app px-3.5 py-3">
      <span
        aria-hidden
        className={entry.open ? "forge-pulse mt-1.5 size-2 flex-none rounded-full" : "mt-1.5 size-2 flex-none rounded-full"}
        style={{ background: color.dot }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="fg-body-sm font-semibold text-fg">{entry.verb}</span>
          <span className="font-mono text-[12.5px] font-bold text-muted">{entry.object}</span>
          <span className="fg-body-sm font-semibold" style={{ color: color.fg }}>
            {entry.outcome}
          </span>
          {entry.repeats > 1 && (
            <Tooltip label={`Attempts ${entry.positions.join(", ")} were identical.`}>
              <span className="inline-flex">
                <Badge tone={entry.tone === "failure" ? "red" : "neutral"}>
                  ×{entry.repeats}
                </Badge>
              </span>
            </Tooltip>
          )}
        </div>

        {entry.detail && (
          <p className="fg-caption break-words text-muted">{entry.detail}</p>
        )}
        {entry.action && (
          <p className="fg-caption break-words" style={{ color: "var(--amberw-600)" }}>
            {entry.action}
          </p>
        )}

        <div className="fg-caption flex flex-wrap items-center gap-x-3 gap-y-1 text-subtle">
          <span className="inline-flex min-w-0 items-center gap-1">
            <Icon name="server" size={11} className="flex-none align-[-1px]" />
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
      <Skeleton variant="text" className="w-[120px]" />
      <Skeleton className="h-[78px]" />
      <Skeleton className="h-[78px]" />
      <Skeleton className="h-[78px]" />
    </div>
  );
}
