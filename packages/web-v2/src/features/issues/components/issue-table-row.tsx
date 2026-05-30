"use client";

// One issue row (desktop table). Lazy per-row cost + dependency badges (React
// Query dedupes/caches; pageSize 25 bounds the fan-out). Inline edits commit
// via the shared mutations passed down from the screen.

import { useRouter } from "next/navigation";
import { Avatar, MonoTag, PipelineTracker, Stat, TD, TR, type SelectOption } from "@/design";
import type { PatchIssueInput } from "../api";
import { useIssueCost, useIssueDeps } from "../hooks";
import { depCounts, initials, memberLabel, statusToRun, statusToStage } from "../derive";
import type { IssueComplexity, IssuePriority, IssueRow, IssueStatus, ProjectMember } from "../types";
import { InlineSelect, StatusEdit } from "./inline-edit-cell";

export interface RowActions {
  patch: (args: { id: string; body: PatchIssueInput }) => void;
  transition: (args: { id: string; toStatus: IssueStatus }) => void;
  isPending: boolean;
}

export const PRIORITY_OPTIONS: SelectOption[] = [
  { value: "critical", label: "critical" },
  { value: "high", label: "high" },
  { value: "medium", label: "medium" },
  { value: "low", label: "low" },
  { value: "none", label: "none" },
];

export const COMPLEXITY_OPTIONS: SelectOption[] = [
  { value: "", label: "—" },
  { value: "xs", label: "xs" },
  { value: "s", label: "s" },
  { value: "m", label: "m" },
  { value: "l", label: "l" },
  { value: "xl", label: "xl" },
];

export function assigneeOptions(members: ProjectMember[] | undefined): SelectOption[] {
  return [
    { value: "", label: "Unassigned" },
    ...(members ?? []).map((m) => ({ value: m.userId, label: m.email })),
  ];
}

/** Lazy dependency badges (🔒 blocked-by · → blocks). */
export function DepBadges({ id }: { id: string }) {
  const { data } = useIssueDeps(id);
  const { blockedBy, blocks } = depCounts(data);
  if (!blockedBy && !blocks) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {blockedBy > 0 && (
        <span className="fg-caption inline-flex items-center gap-0.5" title={`Blocked by ${blockedBy}`}>
          🔒 {blockedBy}
        </span>
      )}
      {blocks > 0 && (
        <span className="fg-caption inline-flex items-center gap-0.5" title={`Blocks ${blocks}`}>
          → {blocks}
        </span>
      )}
    </span>
  );
}

/** Lazy per-issue cost. */
export function CostCell({ id }: { id: string }) {
  const { data, isLoading } = useIssueCost(id);
  if (isLoading) return <span className="fg-caption">…</span>;
  const cost = data?.estimatedCost ?? 0;
  return <Stat icon="dollar">{cost > 0 ? `$${cost.toFixed(2)}` : "—"}</Stat>;
}

export function IssueTableRow({
  row,
  slug,
  members,
  actions,
}: {
  row: IssueRow;
  slug: string;
  members: ProjectMember[] | undefined;
  actions: RowActions;
}) {
  const router = useRouter();
  const stage = statusToStage(row.status);
  const open = () => router.push(`/projects/${slug}/issues/${row.id}`);

  return (
    <TR>
      <TD>
        <button type="button" onClick={open} className="focus-visible:outline-none">
          <MonoTag hue="cobalt">{row.displayId}</MonoTag>
        </button>
      </TD>
      <TD className="max-w-[320px]">
        <button type="button" onClick={open} className="block w-full text-left focus-visible:outline-none">
          <span className="fg-body-sm block truncate text-fg hover:text-accent-text">{row.title}</span>
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {row.category && <MonoTag>{row.category}</MonoTag>}
          <DepBadges id={row.id} />
        </div>
      </TD>
      <TD>
        <PipelineTracker stage={stage} status={statusToRun(row.status, row.agentStatus)} variant="mini" />
      </TD>
      <TD>
        <StatusEdit
          status={row.status}
          agentStatus={row.agentStatus}
          disabled={actions.isPending}
          onTransition={(toStatus) => actions.transition({ id: row.id, toStatus })}
        />
      </TD>
      <TD className="min-w-[120px]">
        <InlineSelect
          ariaLabel="Priority"
          value={row.priority}
          options={PRIORITY_OPTIONS}
          disabled={actions.isPending}
          onCommit={(priority) =>
            actions.patch({ id: row.id, body: { priority: priority as IssuePriority } })
          }
        />
      </TD>
      <TD className="min-w-[88px]">
        <InlineSelect
          ariaLabel="Complexity"
          value={row.complexity ?? ""}
          options={COMPLEXITY_OPTIONS}
          disabled={actions.isPending}
          onCommit={(c) =>
            actions.patch({ id: row.id, body: { complexity: c === "" ? null : (c as IssueComplexity) } })
          }
        />
      </TD>
      <TD className="text-right">
        <CostCell id={row.id} />
      </TD>
      <TD className="min-w-[160px]">
        <div className="flex items-center gap-2">
          <Avatar initials={initials(memberLabel(row.assigneeId, members))} size={22} />
          <InlineSelect
            ariaLabel="Assignee"
            value={row.assigneeId ?? ""}
            options={assigneeOptions(members)}
            disabled={actions.isPending}
            onCommit={(uid) => actions.patch({ id: row.id, body: { assigneeId: uid === "" ? null : uid } })}
            className="min-w-0 flex-1"
          />
        </div>
      </TD>
    </TR>
  );
}
