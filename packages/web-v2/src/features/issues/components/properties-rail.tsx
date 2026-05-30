"use client";

// Issue-detail properties rail. Read + inline-edit of the core fields, plus a
// cost rollup, merge date (no merge-commit SHA is stored — `mergedAt` is the
// signal), the ISS-<seq> branch convention, and dependency edges (ID-only from
// the API — shown with kind + a short id label).

import { Avatar, MonoTag, Stat } from "@/design";
import {
  COMPLEXITY_OPTIONS,
  PRIORITY_OPTIONS,
  assigneeOptions,
} from "./issue-table-row";
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

function DepList({ edges, self, label }: { edges: IssueDependencyEdge[]; self: string; label: string }) {
  if (edges.length === 0) return null;
  return (
    <div className="py-2">
      <p className="fg-caption mb-1">{label}</p>
      <div className="flex flex-wrap justify-end gap-1.5">
        {edges.map((e) => {
          const other = e.fromIssueId === self ? e.toIssueId : e.fromIssueId;
          return (
            <MonoTag key={e.id} hue={e.kind === "blocks" ? "flame" : "neutral"}>
              {e.kind} · {other.slice(0, 8)}
            </MonoTag>
          );
        })}
      </div>
    </div>
  );
}

interface PropertiesRailProps {
  issue: IssueDetail;
  members: ProjectMember[] | undefined;
  cost: IssueCostSummary | undefined;
  deps: IssueDependencies | undefined;
  pending: boolean;
  onPatch: (body: { priority?: IssuePriority; complexity?: IssueComplexity | null; assigneeId?: string | null }) => void;
  onTransition: (toStatus: IssueStatus) => void;
}

export function PropertiesRail({
  issue,
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
      <DepList edges={blockedBy} self={issue.id} label="Blocked by" />
      <DepList edges={blocks} self={issue.id} label="Blocks" />
      <DepList edges={relates} self={issue.id} label="Related" />
    </div>
  );
}
