"use client";

// Issue-detail properties rail. Read + inline-edit of the core fields, plus a
// cost rollup, the merge mark (its date, and whether Forge observed the merge or
// only recorded somebody's claim of it — ISS-1126), the branch core's work-evidence
// gate counts, and dependency edges (rendered as clickable `ISS-X` badges linking
// to the related issue — ISS-331).

import { couldNotRead, couldNotRefresh } from "@/lib/api/read-failed";
import type { ComponentProps } from "react";
import { Avatar, Badge, Button, MonoTag, RetryButton, Stat } from "@/design";
import { COMPLEXITY_OPTIONS, PRIORITY_OPTIONS } from "./issue-row-parts";
import { IssueRefBadge } from "./issue-ref-badge";
import { LANDING_SHAPE_ROW } from "@/lib/api/error";
import { LandingShapeControl } from "./landing-shape-control";
import { LiveReachValue } from "./live-reach-row";
import { MergeMarkerControl } from "./merge-marker-control";
import { RunWordChip } from "./run-word-chip";
import { InlineSelect, StatusEdit } from "./inline-edit-cell";
import { categoryLabel, creatorInitialsOf, creatorLabelOf, splitBlockedBy } from "../derive";
import type { RunWord } from "@/features/runs/derive";
import { heldByAgent } from "../edit-lock";
import { useAuth } from "@/providers/auth-provider";
import type {
  IssueComplexity,
  IssueCostSummary,
  IssueDependencies,
  IssueDependencyEdge,
  IssueDetail,
  IssuePriority,
  IssueStatus,
  LandingShape,
  MergeMarkKind,
} from "../types";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

/** Total tokens an issue consumed across every session, compacted for the rail
 * (`2.4M`, `340K`). Sums input + output + cache (read/creation) — the full
 * usage rollup from `cost-summary`. Cache tokens are real consumption, so they
 * count toward the total. */
function totalTokens(cost: IssueCostSummary | undefined): number {
  if (!cost) return 0;
  return cost.inputTokens + cost.outputTokens + cost.cacheReadTokens + cost.cacheCreationTokens;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="fg-caption flex-none">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

/**
 * ISS-1126 — which kind of merge mark this is, beside the date.
 *
 * `mergedAt` alone reads as "shipped" whichever it is. An `asserted` mark means Forge holds no
 * record of the merge and took somebody's word for it; an `observed` one carries the commit Forge
 * read for itself, off a pull request or the repository. Shown apart from the date because a reader deciding
 * whether the work is really out there is asking this question and not the other one.
 *
 * The kind is core's reading (`merge-record.ts`), never re-derived here. An older server that sends
 * no `mergeMark` renders nothing rather than guessing.
 */
function MergeMarkBadge({
  mark,
  commitSha,
  landing,
  claimedCommit,
  landingShape,
}: {
  mark?: MergeMarkKind;
  commitSha?: string | null;
  landing?: string | null;
  claimedCommit?: string | null;
  landingShape?: LandingShape;
}) {
  if (mark === "landed") {
    // ISS-1327 — the landing is the evidence, so it is shown as text rather than kept on a hover
    // that keyboard, touch and screen-reader users never reach.
    return (
      <>
        <Badge tone="cobalt">landed</Badge>
        {landing && (
          <span className="fg-body-sm min-w-0 break-all font-mono text-muted" data-testid="merged-landing">
            {landing}
          </span>
        )}
      </>
    );
  }
  if (mark === "observed") {
    // ISS-1421 r8 — the commit is the evidence, shown as text the way a claim's is: a hover alone
    // is never reached at 390 or on touch.
    return (
      <>
        <Badge tone="green">observed</Badge>
        {commitSha && (
          <span
            className="fg-body-sm min-w-0 break-all font-mono text-muted"
            data-testid="merged-commit"
            title={`Forge observed this merge at commit ${commitSha}.`}
          >
            {commitSha.slice(0, 7)}
          </span>
        )}
      </>
    );
  }
  if (mark === "asserted" && commitSha) {
    // ISS-1300 r3 — a commit a person named, which the repository holds: a claim, so not observed.
    return (
      <>
        <Badge tone="amber">claimed</Badge>
        <span
          className="fg-body-sm min-w-0 break-all font-mono text-muted"
          data-testid="merged-stated"
          title={`Commit ${commitSha}. A person named it as where this work landed, and the repository holds it. Forge did not see it land.`}
        >
          {commitSha.slice(0, 7)} — in the repository
        </span>
      </>
    );
  }
  if (mark === "asserted" && claimedCommit) {
    // ISS-1409 — a commit an agent named that Forge could not check: shown as text, with what is
    // owed it, because it is a claim and not a merge.
    return (
      <>
        <Badge tone="amber">claimed</Badge>
        <span
          className="fg-body-sm min-w-0 break-all font-mono text-muted"
          data-testid="merged-claim"
          title={`Commit ${claimedCommit}. Forge could not check it against the repository, so it is a claim. An agent marking the issue merged again checks it once Forge can read the repository.`}
        >
          {claimedCommit.slice(0, 7)} — not verified
        </span>
      </>
    );
  }
  if (mark === "asserted") {
    return (
      <span
        title={
          // Outside git no pull request is the normal record; what the mark lacks is a landing.
          landingShape === "outside_git"
            ? "This mark names no landing — it says the work went out, not where it landed"
            : "Forge holds no merged pull request for this issue — this mark is a claim it recorded, not a merge it witnessed"
        }
      >
        <Badge tone="amber">claimed</Badge>
      </span>
    );
  }
  return null;
}

/** A rail read that failed; `retry` only where reading again could change the answer (ISS-1160). */
export interface UnreadRead {
  error: unknown;
  retry?: (() => void) | undefined;
  /** When the reading still listed was taken, where the read answered before it failed (ISS-1228 r26). */
  readAt?: number | undefined;
}

/** A failed rail read in words: could not be read, or, where it still lists what it read, could not be refreshed. */
function unreadWords(what: string, read: UnreadRead): string {
  return read.readAt ? `${what}: ${couldNotRefresh(read.readAt, read.error)}` : couldNotRead(what, read.error);
}

/** A rail row whose read failed: what could not be read, and Retry (ISS-1228 round 21). */
function UnreadRow({ label, what, read }: { label: string; what: string; read: UnreadRead }) {
  return (
    <Row label={label}>
      <span className="fg-caption inline-flex flex-wrap items-center justify-end gap-2 text-muted">
        <span role="status">{what}</span>
        <RetryButton error={read.error} onRetry={read.retry} />
      </span>
    </Row>
  );
}

/** A relation section (Blocked by / Blocks / Parent / Subtasks / Duplicates /
 *  Related). The section heading conveys the relationship, so each edge renders
 *  only a clickable `ISS-X` badge for the OTHER endpoint (with a status tone
 *  dot when enriched) — falling back to a short id when the server didn't
 *  enrich the edge. Raw `kind` wire values are never shown (ISS-349). */
function DepList({
  edges,
  self,
  slug,
  label,
}: {
  edges: IssueDependencyEdge[];
  self: string;
  slug: string;
  label: string;
}) {
  if (edges.length === 0) return null;
  return (
    <div className="py-2">
      <p className="fg-caption mb-1">{label}</p>
      <div className="flex flex-col items-end gap-1.5">
        {edges.map((e) => {
          const isFromSelf = e.fromIssueId === self;
          const other = isFromSelf ? e.toIssueId : e.fromIssueId;
          const otherDisplayId = isFromSelf ? e.toDisplayId : e.fromDisplayId;
          const otherTitle = isFromSelf ? e.toTitle : e.fromTitle;
          const otherStatus = isFromSelf ? e.toStatus : e.fromStatus;
          return otherDisplayId ? (
            <IssueRefBadge
              key={e.id}
              id={other}
              slug={slug}
              displayId={otherDisplayId}
              title={otherTitle}
              status={otherStatus}
              showTitle
            />
          ) : (
            <MonoTag key={e.id} hue={e.kind === "blocks" ? "flame" : "neutral"}>
              {other.slice(0, 8)}
            </MonoTag>
          );
        })}
      </div>
    </div>
  );
}

interface PropertiesRailProps {
  issue: IssueDetail;
  /** Project slug — for building links from relation badges to related issues. */
  slug: string;
  cost: IssueCostSummary | undefined;
  deps: IssueDependencies | undefined;
  pending: boolean;
  onPatch: (body: { priority?: IssuePriority; complexity?: IssueComplexity | null }) => void;
  onTransition: (toStatus: IssueStatus) => void;
  /** Open the module picker. Absent for a reader who cannot write. */
  onEditModules?: (() => void) | undefined;
  /** ISS-791 — offer the shipped-work claim. False for a reader who cannot write. */
  canMarkMerged?: boolean | undefined;
  /** What a person owes this issue, so the status control at a park offers that decision first. */
  park?: ComponentProps<typeof StatusEdit>["park"];
  /** The run's word, the header chip's own (`issueRunChip`); null where there is none to show. */
  runWord?: RunWord | null;
  /** When that word was read, where the run read has failed since (ISS-1228 r27). */
  runAsOf?: string | null;
  /** A read of the rail's that failed, said as such with a way to read it again, never drawn as none (ISS-1228). */
  unread?: { deps?: UnreadRead | undefined; cost?: UnreadRead | undefined };
  /** A reader who cannot write reads Priority and Complexity as text, not in a disabled control (ISS-1229 r40). */
  readOnly?: boolean;
}

/** A field's value as text, by its option's label; an unset one reads "Not set". */
function ReadValue({ label, value, options }: { label: string; value: string; options: readonly { value: string; label: string }[] }) {
  const shown = value ? options.find((o) => o.value === value)?.label : undefined;
  return (
    <span className={`text-13-5 leading-normal ${shown ? "text-fg" : "text-muted"}`} data-testid={`read-${label.toLowerCase()}`}>
      {shown ?? "Not set"}
    </span>
  );
}

export function PropertiesRail({
  issue,
  slug,
  cost,
  deps,
  pending,
  onPatch,
  onTransition,
  onEditModules,
  canMarkMerged,
  park,
  runWord = null,
  runAsOf = null,
  unread = {},
  readOnly = false,
}: PropertiesRailProps) {
  const viewerId = useAuth().user?.id;
  const modules = (issue.labels ?? []).filter((l) => l.kind === "module");
  const plainLabels = (issue.labels ?? []).filter((l) => l.kind !== "module");
  const primaryModule = modules.find((m) => m.isPrimary);
  const secondaryModules = modules.filter((m) => !m.isPrimary);
  const incoming = deps?.incoming ?? [];
  const outgoing = deps?.outgoing ?? [];
  const isDecompose = (e: IssueDependencyEdge) => e.kind === "decomposes" || e.kind === "parent";
  const { holding: blockedBy, settled: wasBlockedBy } = splitBlockedBy(incoming);
  const blocks = outgoing.filter((e) => e.kind === "blocks");
  const parents = incoming.filter(isDecompose);
  const subtasks = outgoing.filter(isDecompose);
  const duplicates = [...incoming, ...outgoing].filter((e) => e.kind === "duplicates");
  const related = [...incoming, ...outgoing].filter((e) => e.kind === "relates");
  const held = heldByAgent(issue.status, issue.agentStatus);
  const tokens = totalTokens(cost);
  const hasModule = primaryModule !== undefined || secondaryModules.length > 0;
  // An empty field renders no row; one whose action this reader holds keeps the action, on the shared `Not set` row.
  const offerModule = !hasModule && onEditModules !== undefined;
  const offerMerge = !issue.mergedAt && canMarkMerged === true;
  const landingSource =
    issue.declaredLandingShape === undefined ? undefined : issue.declaredLandingShape === null ? "project" : "issue";
  return (
    <div className="divide-y divide-line-subtle">
      <Row label="Status">
        <StatusEdit
          status={issue.status}
          agentStatus={issue.agentStatus}
          disabled={pending}
          onTransition={onTransition}
          park={park}
        />
      </Row>
      {runWord && (
        <Row label="Run">
          <RunWordChip word={runWord} asOf={runAsOf} size="sm" />
        </Row>
      )}
      <Row label="Priority">
        {readOnly ? (
          <ReadValue label="Priority" value={issue.priority} options={PRIORITY_OPTIONS} />
        ) : (
          <InlineSelect
            ariaLabel="Priority"
            value={issue.priority}
            options={PRIORITY_OPTIONS}
            disabled={pending || held}
            onCommit={(p) => onPatch({ priority: p as IssuePriority })}
            className="w-36"
          />
        )}
      </Row>
      <Row label="Complexity">
        {readOnly ? (
          <ReadValue label="Complexity" value={issue.complexity ?? ""} options={COMPLEXITY_OPTIONS} />
        ) : (
          <InlineSelect
            ariaLabel="Complexity"
            value={issue.complexity ?? ""}
            options={COMPLEXITY_OPTIONS}
            disabled={pending || held}
            onCommit={(c) => onPatch({ complexity: c === "" ? null : (c as IssueComplexity) })}
            className="w-36"
          />
        )}
      </Row>
      <Row label="Creator">
        <div className="flex items-center justify-end gap-2">
          <Avatar initials={creatorInitialsOf(issue, viewerId)} size={22} />
          <span className="fg-body-sm truncate text-fg" title={creatorLabelOf(issue, viewerId)}>
            {creatorLabelOf(issue, viewerId)}
          </span>
        </div>
      </Row>
      {issue.category && (
        <Row label="Category">
          <Badge tone="neutral">{categoryLabel(issue.category)}</Badge>
        </Row>
      )}
      {hasModule && (
        <Row label="Module">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {primaryModule && <MonoTag hue="cobalt">{primaryModule.name}</MonoTag>}
            {secondaryModules.map((m) => (
              <MonoTag key={m.id}>{m.name}</MonoTag>
            ))}
            {onEditModules && (
              <Button variant="ghost" size="sm" icon="settings" onClick={onEditModules}>
                Edit
              </Button>
            )}
          </div>
        </Row>
      )}
      {plainLabels.length > 0 && (
        <Row label="Labels">
          <div className="flex flex-wrap justify-end gap-1.5">
            {plainLabels.map((l) => (
              <MonoTag key={l.id}>{l.name}</MonoTag>
            ))}
          </div>
        </Row>
      )}
      {canMarkMerged && (
        <Row label={LANDING_SHAPE_ROW}>
          <LandingShapeControl
            issueId={issue.id}
            declared={issue.declaredLandingShape ?? null}
            effective={issue.landingShape}
            disabled={pending || held}
          />
        </Row>
      )}
      <Row label="Branch">
        {issue.recordedBranch ? (
          <span className="fg-body-sm min-w-0 break-all font-mono text-fg">{issue.recordedBranch}</span>
        ) : (
          <span className="fg-body-sm text-muted">None recorded</span>
        )}
      </Row>
      {issue.mergedAt && (
        <Row label="Merged">
          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
            <span className="fg-body-sm whitespace-nowrap font-mono text-muted">{fmtDate(issue.mergedAt)}</span>
            <MergeMarkBadge
              mark={issue.mergeMark}
              commitSha={issue.mergedCommitSha}
              landing={issue.mergedLanding}
              claimedCommit={issue.mergedClaimedCommit}
              landingShape={issue.landingShape}
            />
            {canMarkMerged && (
              <MergeMarkerControl
                issueId={issue.id}
                mergedAt={issue.mergedAt}
                landingShape={issue.landingShape}
                landingSource={landingSource}
                mergedCommitSha={issue.mergedCommitSha}
                newestMergedPull={issue.newestMergedPull}
                commitCheck={issue.markCommitCheck}
                markedTarget={issue.mergedTarget}
                mergeMark={issue.mergeMark}
              />
            )}
          </div>
        </Row>
      )}
      {issue.liveReach && (
        <Row label="Production">
          <LiveReachValue reach={issue.liveReach} />
        </Row>
      )}
      {unread.cost && <UnreadRow label="Cost" what={unreadWords("The cost", unread.cost)} read={unread.cost} />}
      {cost && cost.estimatedCost > 0 && (
        <Row label="Cost">
          <Stat icon="dollar">{`$${cost.estimatedCost.toFixed(2)}`}</Stat>
        </Row>
      )}
      {tokens > 0 && (
        <Row label="Tokens">
          <Stat icon="cpu">
            <span title={`${tokens.toLocaleString()} tokens`}>{fmtTokens(tokens)}</span>
          </Stat>
        </Row>
      )}
      <Row label="Created">
        <span className="fg-body-sm whitespace-nowrap font-mono text-muted">{fmtDate(issue.createdAt)}</span>
      </Row>
      <Row label="Reopens">
        <span className="fg-body-sm font-mono text-muted">{issue.reopenCount}</span>
      </Row>
      {(offerModule || offerMerge) && (
        <Row label="Not set">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {offerModule && (
              <Button variant="ghost" size="sm" icon="settings" onClick={onEditModules}>
                Set module
              </Button>
            )}
            {offerMerge && (
              <MergeMarkerControl
                issueId={issue.id}
                mergedAt={null}
                landingShape={issue.landingShape}
                landingSource={landingSource}
                mergedCommitSha={issue.mergedCommitSha}
                newestMergedPull={issue.newestMergedPull}
                commitCheck={issue.markCommitCheck}
              />
            )}
          </div>
        </Row>
      )}
      {unread.deps && (
        <UnreadRow label="Relations" what={unreadWords("Its relations", unread.deps)} read={unread.deps} />
      )}
      <DepList edges={blockedBy} self={issue.id} slug={slug} label="Blocked by" />
      <DepList edges={wasBlockedBy} self={issue.id} slug={slug} label="Was blocked by" />
      <DepList edges={blocks} self={issue.id} slug={slug} label="Blocks" />
      <DepList edges={parents} self={issue.id} slug={slug} label="Parent" />
      <DepList edges={subtasks} self={issue.id} slug={slug} label="Subtasks" />
      <DepList edges={duplicates} self={issue.id} slug={slug} label="Duplicates" />
      <DepList edges={related} self={issue.id} slug={slug} label="Related" />
    </div>
  );
}
