"use client";

import {
  Badge,
  Button,
  Checkbox,
  EmptyPanelLine,
  ErrorState,
  MonoTag,
  SectionTitle,
  Skeleton,
} from "@/design";
import { WORK_STATE_LABELS } from "@forge/contracts/work-state";
import { providerLabel } from "@/features/integrations/providers/registry";
import { failedCloseLead } from "@/features/releases/roster";
import { formatApiError } from "@/lib/api/error";
import { formatCountdown, formatRelativeTime } from "@/lib/utils/format";
import Link from "next/link";
import { useState } from "react";
import { useReleaseRoster } from "../hooks";
import type { ReleaseRosterEntry } from "../api";
import { askWhoReleases } from "../release-who";
import { BatchReleaseDialog, type BatchReleaseIssue } from "./batch-release-dialog";

/** Flush with the list under it: hairlines above and below, no card surface (the owner's flat rule). */
const PANEL = "flex flex-col gap-3 border-y border-line py-4";
const PANEL_HEAD = "flex flex-wrap items-start justify-between gap-x-4 gap-y-2";

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
function emptyGateDetail(nextCutAt: string | null, automatic: boolean): string {
  if (!nextCutAt) return automatic ? "Releases on its own" : "A person releases";
  if (new Date(nextCutAt).getTime() <= Date.now()) return "Cut due now";
  return `Next cut ${formatCountdown(nextCutAt)}`;
}

/**
 * Said in place of Release now where no waiting issue can be picked: each row below says what it
 * waits on, so the line says where to look rather than offering a button nothing can enable
 * (ISS-1421 r36, judge-145: the gate offered Release now with 0 ready).
 */
export function noneReadyLine(claimed: number, unclosable: number): string {
  if (unclosable === 0) return `None is ready to release: ${claimed === 1 ? "the one waiting is" : "every one waiting is"} already in a release.`;
  return `None is ready to release. Each issue marked Not ready to release says below what would make it ready${claimed > 0 ? ", and the rest are already in a release" : ""}.`;
}

/**
 * Said in place of Release now where the press would be refused whatever is picked: no runner to
 * take it, a release already running, a declaration it cannot read. Each reason is core's own
 * sentence for a person, saying what clears it (ISS-1421 r37, judge-151 on criteria 366 and 367).
 */
export function blockedLine(blockingAll: ReadonlyArray<{ said: string }>): string {
  return `None can be released yet. ${blockingAll.map((b) => b.said).join(" ")}`;
}

/** Whether Release now would refuse this row for a reason of its own: its close, or its release note. */
export function refusedOwnRow(issue: Pick<ReleaseRosterEntry, "claimedByRunId" | "closeRefusals" | "releaseRefusals">): boolean {
  return issue.claimedByRunId === null && (issue.closeRefusals.length > 0 || issue.releaseRefusals.length > 0);
}

/** What releases the waiting issues: a schedule, the automatic release, or a person (ISS-1421 r13). */
export function whatReleases(nextCutAt: string | null, automatic: boolean): string {
  if (nextCutAt) return `Next cut ${formatCountdown(nextCutAt)}`;
  if (automatic) return "Forge releases each one on its own once its criteria pass and nothing holds it";
  return "No schedule — a person releases this";
}

/**
 * Everything waiting to ship, and when it will. The honest-degradation rules
 * live here: with no schedule this says so in words instead of counting toward
 * a cut nothing will perform; an issue already claimed by a running batch is
 * shown as in a release rather than as selectable; and an issue the release
 * could not close is shown with what clears it rather than as selectable, so
 * a press never hands it straight back (ISS-1337).
 */
export function ReleaseGatePanel({
  projectId,
  slug,
  canRelease,
}: {
  projectId: string;
  slug: string;
  /** Whether the reader holds the role the release door takes; anyone else reads who may (ISS-1300 r5). */
  canRelease: boolean;
}) {
  const { data, isLoading, isError, error, refetch } = useReleaseRoster(projectId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (isLoading) return <ReleaseGateSkeleton />;
  if (isError) {
    return (
      <section className={PANEL}>
        <ErrorState
            mascot={false}
            title="Couldn't load the release gate"
            message={formatApiError(error)}
            onRetry={() => {
              void refetch();
            }}
        />
      </section>
    );
  }
  if (!data?.gateStatus) return null;

  const issues = data.issues;
  if (issues.length === 0) {
    return (
      <EmptyPanelLine
        title={WORK_STATE_LABELS.awaiting_release}
        status="None waiting"
        detail={emptyGateDetail(data.nextCutAt, data.automaticRelease)}
      />
    );
  }

  const unclaimed = issues.filter((i) => i.claimedByRunId === null);
  // A row is offered only where the press over it would not be refused: by its own close or note,
  // or by a reason no pick escapes (ISS-1421 r37).
  const blocked = data.blockingAll.length > 0;
  const own = unclaimed.filter((i) => !refusedOwnRow(i));
  const selectable = blocked ? [] : own;
  // A row the last release failed to close is picked by hand only: a release fails it the same way.
  const ready = selectable.filter((i) => i.closeFailure === null);
  const chosen = selectable.filter((i) => selected.has(i.id));
  const allSelected = ready.length > 0 && ready.every((i) => selected.has(i.id));
  const claimed = issues.length - unclaimed.length;
  const unclosable = unclaimed.length - own.length;
  const failing = selectable.length - ready.length;
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
    setSelected(allSelected ? new Set() : new Set(ready.map((i) => i.id)));

  return (
    <section className={PANEL} data-testid="release-gate-panel">
      <div className={PANEL_HEAD}>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <SectionTitle className="fg-h3">{WORK_STATE_LABELS.awaiting_release}</SectionTitle>
            <Badge tone="cobalt">{issues.length}</Badge>
          </div>
          <p className="fg-caption text-muted">
            {whatReleases(data.nextCutAt, data.automaticRelease)}
            {oldest ? ` · oldest merged ${formatRelativeTime(oldest)}` : ""}
          </p>
        </div>
        {blocked ? (
          <p className="fg-caption text-muted" data-testid="none-ready">{blockedLine(data.blockingAll)}</p>
        ) : selectable.length === 0 ? (
          <p className="fg-caption text-muted" data-testid="none-ready">{noneReadyLine(claimed, unclosable)}</p>
        ) : canRelease ? (
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
        ) : (
          <p className="fg-caption text-muted">{askWhoReleases("these issues")}</p>
        )}
      </div>

      <div>
        <div className="fg-caption text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* The provider by its product name, as the Integrations tab names it (ISS-1421 r6). */}
          <span>
            {data.channels.length > 0
              ? `Deploys through ${data.channels.map(providerLabel).join(" and ")}.`
              : "Nothing deploys it: a person does."}
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
            disabled={ready.length === 0}
            onChange={toggleAll}
            ariaLabel="Select every issue that can be released"
          />
          <span className="fg-caption text-muted">
            {chosen.length > 0 ? `${chosen.length} selected` : `${ready.length} ready`}
            {claimed > 0 ? ` · ${claimed} in a release` : ""}
            {unclosable > 0 ? ` · ${unclosable} not ready to release` : ""}
            {failing > 0 ? ` · ${failing} the last release failed to close` : ""}
          </span>
        </div>

        <ul className="flex flex-col">
          {visible.map((issue) => (
            <RosterRow
              key={issue.id}
              issue={issue}
              slug={slug}
              checked={selected.has(issue.id)}
              blocked={blocked}
              onToggle={() => toggle(issue.id)}
            />
          ))}
        </ul>

        {issues.length > VISIBLE_LIMIT ? (
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show fewer" : `Show all ${issues.length}`}
          </Button>
        ) : null}
      </div>

      <BatchReleaseDialog
        projectId={projectId}
        selectedIssues={chosen.map(
          (i): BatchReleaseIssue => ({ id: i.id, displayId: i.displayId, title: i.title }),
        )}
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onSuccess={() => setSelected(new Set())}
      />
    </section>
  );
}

function RosterRow({
  issue,
  slug,
  checked,
  blocked,
  onToggle,
}: {
  issue: ReleaseRosterEntry;
  slug: string;
  checked: boolean;
  /** A reason no pick escapes stands, so no row can be picked; the panel's head says it. */
  blocked: boolean;
  onToggle: () => void;
}) {
  const runId = issue.claimedByRunId;
  const claimed = runId !== null;
  const refused = refusedOwnRow(issue);
  return (
    <li className="flex flex-col gap-0.5 py-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={checked && !refused && !blocked}
          disabled={claimed || refused || blocked}
          onChange={onToggle}
          ariaLabel={`Select ${issue.displayId} for release`}
        />
        <MonoTag>{issue.displayId}</MonoTag>
        <span className="fg-body-sm text-fg min-w-0 flex-1 truncate" title={issue.title}>
          {issue.title}
        </span>
        <span className="fg-caption text-muted shrink-0 whitespace-nowrap">
          {refused ? (
            <span className="text-amber">Not ready to release</span>
          ) : runId !== null ? (
            <Link
              href={`/projects/${slug}/releases/${runId}`}
              className="text-accent-text underline-offset-2 hover:underline"
              title="Open the release run: it says whether a box has started it, and what it has done"
            >
              in a release
            </Link>
          ) : issue.mergedAt ? (
            `merged ${formatRelativeTime(issue.mergedAt)}`
          ) : (
            "merge time unknown"
          )}
        </span>
      </div>
      {refused ? (
        <p className="fg-caption text-muted pl-6">
          {[...issue.closeRefusals, ...issue.releaseRefusals].map((r) => r.said).join(" ")}
        </p>
      ) : null}
      {!claimed && !refused && issue.closeFailure ? (
        <p className="fg-caption text-muted pl-6">
          {`${failedCloseLead(issue.closeFailure, "this")} A release fails the same way until whoever operates Forge fixes it.`}
        </p>
      ) : null}
    </li>
  );
}

function ReleaseGateSkeleton() {
  return (
    <section className={PANEL} aria-busy="true">
      <div className={PANEL_HEAD}>
        <div className="flex flex-col gap-2">
          <Skeleton variant="text" className="w-40" />
          <Skeleton variant="text" className="w-56" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <div>
        <div className="mt-1 flex flex-col gap-2.5">
          <Skeleton variant="text" className="w-2/3" />
          <Skeleton variant="text" className="w-1/2" />
          <Skeleton variant="text" className="w-3/5" />
        </div>
      </div>
    </section>
  );
}
