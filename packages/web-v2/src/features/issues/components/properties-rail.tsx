"use client";

// Issue-detail properties rail. Read + inline-edit of the core fields, plus a
// cost rollup, the merge mark (its date, and whether Forge observed the merge or
// only recorded somebody's claim of it — ISS-1126), the ISS-<seq> branch
// convention, and dependency edges (rendered as clickable `ISS-X` badges linking
// to the related issue — ISS-331).

import { Avatar, Badge, Button, MonoTag, Stat, StatusChip } from "@/design";
import { COMPLEXITY_OPTIONS, PRIORITY_OPTIONS } from "./issue-table-row";
import { IssueRefBadge } from "./issue-ref-badge";
import { LiveReachValue } from "./live-reach-row";
import { MergeMarkerControl } from "./merge-marker-control";
import { InlineSelect, StatusEdit } from "./inline-edit-cell";
import { creatorLabelOf, initials, runStatusChip } from "../derive";
import { AGENT_HOLDS_EDIT, heldByAgent } from "../edit-lock";
import type {
  IssueComplexity,
  IssueCostSummary,
  IssueDependencies,
  IssueDependencyEdge,
  IssueDetail,
  IssuePriority,
  IssueStatus,
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

/** Title-case a free-text category (`improvement` → `Improvement`). */
function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
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
 * read off its own record of the pull request. Shown apart from the date because a reader deciding
 * whether the work is really out there is asking this question and not the other one.
 *
 * The kind is core's reading (`merge-record.ts`), never re-derived here. An older server that sends
 * no `mergeMark` renders nothing rather than guessing.
 */
function MergeMarkBadge({
  mark,
  commitSha,
}: {
  mark?: "unmarked" | "asserted" | "observed";
  commitSha?: string | null;
}) {
  if (mark === "observed") {
    return (
      <span title={`Forge observed this merge at ${commitSha ?? "a commit it recorded"}`}>
        <Badge tone="green">observed</Badge>
      </span>
    );
  }
  if (mark === "asserted") {
    return (
      <span title="Forge holds no merged pull request for this issue — this mark is a claim it recorded, not a merge it witnessed">
        <Badge tone="amber">claimed</Badge>
      </span>
    );
  }
  return null;
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
}: PropertiesRailProps) {
  const modules = (issue.labels ?? []).filter((l) => l.kind === "module");
  const plainLabels = (issue.labels ?? []).filter((l) => l.kind !== "module");
  const primaryModule = modules.find((m) => m.isPrimary);
  const secondaryModules = modules.filter((m) => !m.isPrimary);
  const incoming = deps?.incoming ?? [];
  const outgoing = deps?.outgoing ?? [];
  const isDecompose = (e: IssueDependencyEdge) => e.kind === "decomposes" || e.kind === "parent";
  const blockedBy = incoming.filter((e) => e.kind === "blocks");
  const blocks = outgoing.filter((e) => e.kind === "blocks");
  const parents = incoming.filter(isDecompose);
  const subtasks = outgoing.filter(isDecompose);
  const duplicates = [...incoming, ...outgoing].filter((e) => e.kind === "duplicates");
  const related = [...incoming, ...outgoing].filter((e) => e.kind === "relates");
  const held = heldByAgent(issue.status, issue.agentStatus);
  const runChip = runStatusChip(issue.agentStatus);
  const tokens = totalTokens(cost);
  const hasModule = primaryModule !== undefined || secondaryModules.length > 0;
  // An empty field renders no row; one whose action this reader holds keeps the action, on the shared `Not set` row.
  const offerModule = !hasModule && onEditModules !== undefined;
  const offerMerge = !issue.mergedAt && canMarkMerged === true;
  return (
    <div className="divide-y divide-line-subtle">
      {held && (
        <p role="status" className="fg-body-sm py-2 text-subtle">
          {AGENT_HOLDS_EDIT}
        </p>
      )}
      <Row label="Status">
        <StatusEdit
          status={issue.status}
          agentStatus={issue.agentStatus}
          disabled={pending}
          onTransition={onTransition}
        />
      </Row>
      {runChip && (
        <Row label="Run">
          <StatusChip status={runChip} size="sm" domain="session" />
        </Row>
      )}
      <Row label="Priority">
        <InlineSelect
          ariaLabel="Priority"
          value={issue.priority}
          options={PRIORITY_OPTIONS}
          disabled={pending || held}
          onCommit={(p) => onPatch({ priority: p as IssuePriority })}
          className="w-36"
        />
      </Row>
      <Row label="Complexity">
        <InlineSelect
          ariaLabel="Complexity"
          value={issue.complexity ?? ""}
          options={COMPLEXITY_OPTIONS}
          disabled={pending || held}
          onCommit={(c) => onPatch({ complexity: c === "" ? null : (c as IssueComplexity) })}
          className="w-36"
        />
      </Row>
      <Row label="Creator">
        <div className="flex items-center justify-end gap-2">
          <Avatar initials={initials(creatorLabelOf(issue))} size={22} />
          <span className="fg-body-sm truncate text-fg" title={creatorLabelOf(issue)}>
            {creatorLabelOf(issue)}
          </span>
        </div>
      </Row>
      {issue.category && (
        <Row label="Category">
          <Badge tone="neutral">{titleCase(issue.category)}</Badge>
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
      <Row label="Branch">
        <MonoTag>{issue.displayId}</MonoTag>
      </Row>
      {issue.mergedAt && (
        <Row label="Merged">
          <div className="flex items-center justify-end gap-2">
            <span className="fg-body-sm font-mono text-muted">{fmtDate(issue.mergedAt)}</span>
            <MergeMarkBadge mark={issue.mergeMark} commitSha={issue.mergedCommitSha} />
            {canMarkMerged && (
              <MergeMarkerControl
                issueId={issue.id}
                mergedAt={issue.mergedAt}
                suggestedTarget={issue.displayId}
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
        <span className="fg-body-sm font-mono text-muted">{fmtDate(issue.createdAt)}</span>
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
              <MergeMarkerControl issueId={issue.id} mergedAt={null} suggestedTarget={issue.displayId} />
            )}
          </div>
        </Row>
      )}
      <DepList edges={blockedBy} self={issue.id} slug={slug} label="Blocked by" />
      <DepList edges={blocks} self={issue.id} slug={slug} label="Blocks" />
      <DepList edges={parents} self={issue.id} slug={slug} label="Parent" />
      <DepList edges={subtasks} self={issue.id} slug={slug} label="Subtasks" />
      <DepList edges={duplicates} self={issue.id} slug={slug} label="Duplicates" />
      <DepList edges={related} self={issue.id} slug={slug} label="Related" />
    </div>
  );
}
