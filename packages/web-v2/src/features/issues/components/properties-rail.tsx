"use client";

// Issue-detail properties rail. Read + inline-edit of the core fields, plus a
// cost rollup, merge date (no merge-commit SHA is stored — `mergedAt` is the
// signal), the ISS-<seq> branch convention, and dependency edges (rendered as
// clickable `ISS-X` badges linking to the related issue — ISS-331).

import { Avatar, MonoTag, Stat } from "@/design";
import {
  COMPLEXITY_OPTIONS,
  PRIORITY_OPTIONS,
  assigneeOptions,
} from "./issue-table-row";
import { IssueRefBadge } from "./issue-ref-badge";
import { InlineSelect, StatusEdit } from "./inline-edit-cell";
import { initials, memberLabel } from "../derive";
import type {
  IssueComplexity,
  IssueCostSummary,
  IssueDependencies,
  IssueDependencyEdge,
  IssueDetail,
  IssuePriority,
  IssueStatus,
  ProjectMember,
} from "../types";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="fg-caption flex-none">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

/** A relation list (Blocked by / Blocks / Related). Each edge renders the kind
 *  plus a clickable `ISS-X` badge for the OTHER endpoint — falling back to a
 *  short id only when the server didn't enrich the edge. */
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
          return (
            <span key={e.id} className="inline-flex items-center gap-1.5">
              <span className="fg-caption">{e.kind}</span>
              {otherDisplayId ? (
                <IssueRefBadge id={other} slug={slug} displayId={otherDisplayId} title={otherTitle} />
              ) : (
                <MonoTag hue={e.kind === "blocks" ? "flame" : "neutral"}>{other.slice(0, 8)}</MonoTag>
              )}
            </span>
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
  members: ProjectMember[] | undefined;
  cost: IssueCostSummary | undefined;
  deps: IssueDependencies | undefined;
  pending: boolean;
  onPatch: (body: { priority?: IssuePriority; complexity?: IssueComplexity | null; assigneeId?: string | null }) => void;
  onTransition: (toStatus: IssueStatus) => void;
}

export function PropertiesRail({
  issue,
  slug,
  members,
  cost,
  deps,
  pending,
  onPatch,
  onTransition,
}: PropertiesRailProps) {
  const blockedBy = (deps?.incoming ?? []).filter((e) => e.kind === "blocks");
  const blocks = (deps?.outgoing ?? []).filter((e) => e.kind === "blocks");
  const relates = [...(deps?.incoming ?? []), ...(deps?.outgoing ?? [])].filter(
    (e) => e.kind !== "blocks",
  );

  return (
    <div className="divide-y divide-line-subtle">
      <Row label="Status">
        <StatusEdit
          status={issue.status}
          agentStatus={issue.agentStatus}
          disabled={pending}
          onTransition={onTransition}
        />
      </Row>
      <Row label="Priority">
        <InlineSelect
          ariaLabel="Priority"
          value={issue.priority}
          options={PRIORITY_OPTIONS}
          disabled={pending}
          onCommit={(p) => onPatch({ priority: p as IssuePriority })}
          className="w-36"
        />
      </Row>
      <Row label="Complexity">
        <InlineSelect
          ariaLabel="Complexity"
          value={issue.complexity ?? ""}
          options={COMPLEXITY_OPTIONS}
          disabled={pending}
          onCommit={(c) => onPatch({ complexity: c === "" ? null : (c as IssueComplexity) })}
          className="w-36"
        />
      </Row>
      <Row label="Assignee">
        <div className="flex items-center justify-end gap-2">
          <Avatar initials={initials(memberLabel(issue.assigneeId, members))} size={22} />
          <InlineSelect
            ariaLabel="Assignee"
            value={issue.assigneeId ?? ""}
            options={assigneeOptions(members)}
            disabled={pending}
            onCommit={(uid) => onPatch({ assigneeId: uid === "" ? null : uid })}
            className="w-40"
          />
        </div>
      </Row>
      <Row label="Category">
        {issue.category ? <MonoTag>{issue.category}</MonoTag> : <span className="fg-caption">—</span>}
      </Row>
      {issue.labels && issue.labels.length > 0 && (
        <Row label="Labels">
          <div className="flex flex-wrap justify-end gap-1.5">
            {issue.labels.map((l) => (
              <MonoTag key={l.id}>{l.name}</MonoTag>
            ))}
          </div>
        </Row>
      )}
      <Row label="Branch">
        <MonoTag>{`ISS-${issue.issSeq}`}</MonoTag>
      </Row>
      <Row label="Merged">
        <span className="fg-body-sm font-mono text-muted">{fmtDate(issue.mergedAt)}</span>
      </Row>
      <Row label="Cost">
        <Stat icon="dollar">
          {cost && cost.estimatedCost > 0 ? `$${cost.estimatedCost.toFixed(2)}` : "—"}
        </Stat>
      </Row>
      <Row label="Created">
        <span className="fg-body-sm font-mono text-muted">{fmtDate(issue.createdAt)}</span>
      </Row>
      <Row label="Reopens">
        <span className="fg-body-sm font-mono text-muted">{issue.reopenCount}</span>
      </Row>
      <DepList edges={blockedBy} self={issue.id} slug={slug} label="Blocked by" />
      <DepList edges={blocks} self={issue.id} slug={slug} label="Blocks" />
      <DepList edges={relates} self={issue.id} slug={slug} label="Related" />
    </div>
  );
}
