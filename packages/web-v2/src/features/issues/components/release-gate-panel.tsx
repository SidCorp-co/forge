"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  ErrorState,
  MonoTag,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatCountdown, formatRelativeTime } from "@/lib/utils/format";
import { useState } from "react";
import { useReleaseRoster } from "../hooks";
import type { ReleaseRosterEntry } from "../api";
import { BatchReleaseDialog, type BatchReleaseIssue } from "./batch-release-dialog";

/** Rows shown before the list collapses behind a "show all" toggle. */
const VISIBLE_LIMIT = 5;

// cm:edge contract -> packages/core/src/release-batch/queries.ts — picks the oldest by comparing `mergedAt` as STRINGS, which is only chronological because that endpoint emits `Date.toISOString()` (always UTC, fixed width). An endpoint that ever sends a zoned offset like `+07:00` would silently name the wrong row as oldest, and the header would read a merge age nobody can reproduce.
function oldestMergedAt(issues: ReleaseRosterEntry[]): string | null {
  return issues.reduce<string | null>(
    (acc, i) => (i.mergedAt && (acc === null || i.mergedAt < acc) ? i.mergedAt : acc),
    null,
  );
}

/**
 * Everything waiting to ship, and when it will. The two honest-degradation
 * rules live here: with no schedule this says so in words instead of counting
 * toward a cut nothing will perform, and an issue already claimed by a running
 * batch is shown as shipping rather than as selectable.
 */
export function ReleaseGatePanel({ projectId }: { projectId: string }) {
  const { data, isLoading, isError, error, refetch } = useReleaseRoster(projectId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (isLoading) return <ReleaseGateSkeleton />;
  if (isError) {
    return (
      <Card>
        <CardContent>
          <ErrorState
            mascot={false}
            title="Couldn't load the release gate"
            message={formatApiError(error)}
            onRetry={() => {
              void refetch();
            }}
          />
        </CardContent>
      </Card>
    );
  }
  // cm:guard a null gate means this project HAS no release gate, which is a real answer and renders nothing. It is reachable only after the loading and error branches above have each returned their own state — collapsing any of the three back into a shared `return null` makes "no gate" and "we don't know" indistinguishable on screen.
  if (!data?.gateStatus) return null;

  const issues = data.issues;
  const selectable = issues.filter((i) => i.claimedByRunId === null);
  const chosen = selectable.filter((i) => selected.has(i.id));
  const allSelected = selectable.length > 0 && chosen.length === selectable.length;
  const claimed = issues.length - selectable.length;
  const visible = expanded ? issues : issues.slice(0, VISIBLE_LIMIT);
  const oldest = oldestMergedAt(issues);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(selectable.map((i) => i.id)));

  return (
    <Card>
      <CardHeader className="flex-wrap gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <CardTitle>Awaiting release</CardTitle>
            <Badge tone="cobalt">{issues.length}</Badge>
          </div>
          <p className="fg-body-xs text-fg-muted">
            {data.nextCutAt
              ? `Next cut ${formatCountdown(data.nextCutAt)}`
              : "No schedule — a person releases this"}
            {oldest ? ` · oldest merged ${formatRelativeTime(oldest)}` : ""}
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={chosen.length === 0}
          title={
            chosen.length === 0
              ? "Select at least one issue to release"
              : "Merge, deploy and close the selected issues"
          }
          onClick={() => setConfirmOpen(true)}
        >
          Release {chosen.length > 0 ? `${chosen.length} ` : ""}now
        </Button>
      </CardHeader>

      <CardContent>
        <div className="fg-body-xs text-fg-muted flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Deploys via <MonoTag>{data.channel ?? "nothing — a person deploys"}</MonoTag>
          </span>
          {data.releaseRunnerLabel ? (
            <span>
              Only runners labelled <MonoTag>{data.releaseRunnerLabel}</MonoTag> may ship it
            </span>
          ) : null}
        </div>

        {issues.length === 0 ? (
          <EmptyState
            mascot={false}
            title="Nothing is waiting"
            message="Merged work lands here until a release ships it."
          />
        ) : (
          <>
            <div className="border-line-subtle mt-3 flex items-center gap-2 border-b pb-2">
              <Checkbox
                checked={allSelected}
                indeterminate={chosen.length > 0 && !allSelected}
                disabled={selectable.length === 0}
                onChange={toggleAll}
                ariaLabel="Select every issue that can be released"
              />
              <span className="fg-body-xs text-fg-muted">
                {chosen.length > 0 ? `${chosen.length} selected` : `${selectable.length} ready`}
                {claimed > 0 ? ` · ${claimed} shipping now` : ""}
              </span>
            </div>

            <ul className="flex flex-col">
              {visible.map((issue) => (
                <RosterRow
                  key={issue.id}
                  issue={issue}
                  checked={selected.has(issue.id)}
                  onToggle={() => toggle(issue.id)}
                />
              ))}
            </ul>

            {issues.length > VISIBLE_LIMIT ? (
              <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
                {expanded ? "Show fewer" : `Show all ${issues.length}`}
              </Button>
            ) : null}
          </>
        )}
      </CardContent>

      <BatchReleaseDialog
        projectId={projectId}
        selectedIssues={chosen.map(
          (i): BatchReleaseIssue => ({ id: i.id, displayId: i.displayId, title: i.title }),
        )}
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onSuccess={() => setSelected(new Set())}
      />
    </Card>
  );
}

function RosterRow({
  issue,
  checked,
  onToggle,
}: {
  issue: ReleaseRosterEntry;
  checked: boolean;
  onToggle: () => void;
}) {
  const claimed = issue.claimedByRunId !== null;
  return (
    <li className="flex items-center gap-2 py-1.5">
      <Checkbox
        checked={checked}
        disabled={claimed}
        onChange={onToggle}
        ariaLabel={`Select ${issue.displayId} for release`}
      />
      <MonoTag>{issue.displayId}</MonoTag>
      <span className="fg-body-sm text-fg min-w-0 flex-1 truncate" title={issue.title}>
        {issue.title}
      </span>
      <span className="fg-body-xs text-fg-muted shrink-0 whitespace-nowrap">
        {claimed
          ? "shipping now"
          : issue.mergedAt
            ? `merged ${formatRelativeTime(issue.mergedAt)}`
            : "merge time unknown"}
      </span>
    </li>
  );
}

function ReleaseGateSkeleton() {
  return (
    <Card aria-busy="true">
      <CardHeader>
        <div className="flex flex-col gap-2">
          <Skeleton variant="text" className="w-40" />
          <Skeleton variant="text" className="w-56" />
        </div>
        <Skeleton className="h-8 w-28" />
      </CardHeader>
      <CardContent>
        <div className="mt-1 flex flex-col gap-2.5">
          <Skeleton variant="text" className="w-2/3" />
          <Skeleton variant="text" className="w-1/2" />
          <Skeleton variant="text" className="w-3/5" />
        </div>
      </CardContent>
    </Card>
  );
}
