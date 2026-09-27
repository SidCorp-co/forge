"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyPanelLine,
  ErrorState,
  MonoTag,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatCountdown, formatRelativeTime } from "@/lib/utils/format";
import Link from "next/link";
import { useState } from "react";
import { useReleaseRoster } from "../hooks";
import type { ReleaseRosterEntry } from "../api";
import { BatchReleaseDialog, type BatchReleaseIssue } from "./batch-release-dialog";

/** Rows shown before the list collapses behind a "show all" toggle. */
const VISIBLE_LIMIT = 5;

function oldestMergedAt(issues: ReleaseRosterEntry[]): string | null {
  return issues.reduce<string | null>(
    (acc, i) => (i.mergedAt && (acc === null || i.mergedAt < acc) ? i.mergedAt : acc),
    null,
  );
}

/** The empty gate's one line has to fit a phone whole, so each wording is
 *  short: formatCountdown's "any moment now" would not fit after "Next cut". */
function emptyGateDetail(nextCutAt: string | null): string {
  if (!nextCutAt) return "A person releases";
  if (new Date(nextCutAt).getTime() <= Date.now()) return "Cut due now";
  return `Next cut ${formatCountdown(nextCutAt)}`;
}

/**
 * Everything waiting to ship, and when it will. The two honest-degradation
 * rules live here: with no schedule this says so in words instead of counting
 * toward a cut nothing will perform, and an issue already claimed by a running
 * batch is shown as shipping rather than as selectable.
 */
export function ReleaseGatePanel({ projectId, slug }: { projectId: string; slug: string }) {
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
  if (!data?.gateStatus) return null;

  const issues = data.issues;
  if (issues.length === 0) {
    return (
      <EmptyPanelLine
        title="Awaiting release"
        status="None waiting"
        detail={emptyGateDetail(data.nextCutAt)}
      />
    );
  }

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
          <p className="fg-caption text-muted">
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
        <div className="fg-caption text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Deploys via{" "}
            {data.channels.length > 0 ? (
              data.channels.map((channel) => <MonoTag key={channel}>{channel}</MonoTag>)
            ) : (
              <MonoTag>nothing — a person deploys</MonoTag>
            )}
          </span>
          {data.releaseRunnerLabel ? (
            <span>
              Prefers runners labelled <MonoTag>{data.releaseRunnerLabel}</MonoTag>, and ships on
              another box when none is available
            </span>
          ) : null}
        </div>

        <div className="border-line-subtle mt-3 flex items-center gap-2 border-b pb-2">
          <Checkbox
            checked={allSelected}
            indeterminate={chosen.length > 0 && !allSelected}
            disabled={selectable.length === 0}
            onChange={toggleAll}
            ariaLabel="Select every issue that can be released"
          />
          <span className="fg-caption text-muted">
            {chosen.length > 0 ? `${chosen.length} selected` : `${selectable.length} ready`}
            {claimed > 0 ? ` · ${claimed} shipping now` : ""}
          </span>
        </div>

        <ul className="flex flex-col">
          {visible.map((issue) => (
            <RosterRow
              key={issue.id}
              issue={issue}
              slug={slug}
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
  slug,
  checked,
  onToggle,
}: {
  issue: ReleaseRosterEntry;
  slug: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const runId = issue.claimedByRunId;
  const claimed = runId !== null;
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
      <span className="fg-caption text-muted shrink-0 whitespace-nowrap">
        {runId !== null ? (
          <Link
            href={`/projects/${slug}/releases/${runId}`}
            className="text-accent-text underline-offset-2 hover:underline"
            title="Open what this release run has done so far"
          >
            shipping now
          </Link>
        ) : issue.mergedAt ? (
          `merged ${formatRelativeTime(issue.mergedAt)}`
        ) : (
          "merge time unknown"
        )}
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
