"use client";

// One issue row as a stacked card (mobile, <md). Mirrors the table row with
// OS-native pickers for the inline edits.

import { useRouter } from "next/navigation";
import { Avatar, Card, CardContent, MonoTag, PipelineTracker } from "@/design";
import { initials, memberLabel, statusToRun, statusToStage } from "../derive";
import type { IssueComplexity, IssuePriority, IssueRow, ProjectMember } from "../types";
import {
  COMPLEXITY_OPTIONS,
  CostCell,
  DepBadges,
  PRIORITY_OPTIONS,
  assigneeOptions,
  type RowActions,
} from "./issue-table-row";
import { InlineSelect, StatusEdit } from "./inline-edit-cell";

export function IssueMobileCard({
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
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <button type="button" onClick={open} className="min-w-0 text-left focus-visible:outline-none">
            <MonoTag hue="cobalt">{row.displayId}</MonoTag>
            <span className="fg-body-sm mt-1.5 block truncate text-fg">{row.title}</span>
          </button>
          <Avatar initials={initials(memberLabel(row.assigneeId, members))} size={24} />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {row.category && <MonoTag>{row.category}</MonoTag>}
          <DepBadges id={row.id} />
        </div>

        <div className="mt-3">
          <PipelineTracker stage={stage} status={statusToRun(row.status, row.agentStatus)} variant="mini" />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <StatusEdit
            status={row.status}
            agentStatus={row.agentStatus}
            size="sm"
            disabled={actions.isPending}
            onTransition={(toStatus) => actions.transition({ id: row.id, toStatus })}
          />
          <CostCell id={row.id} />
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <label className="fg-caption flex flex-col gap-1">
            Priority
            <InlineSelect
              native
              ariaLabel="Priority"
              value={row.priority}
              options={PRIORITY_OPTIONS}
              disabled={actions.isPending}
              onCommit={(priority) =>
                actions.patch({ id: row.id, body: { priority: priority as IssuePriority } })
              }
            />
          </label>
          <label className="fg-caption flex flex-col gap-1">
            Complexity
            <InlineSelect
              native
              ariaLabel="Complexity"
              value={row.complexity ?? ""}
              options={COMPLEXITY_OPTIONS}
              disabled={actions.isPending}
              onCommit={(c) =>
                actions.patch({ id: row.id, body: { complexity: c === "" ? null : (c as IssueComplexity) } })
              }
            />
          </label>
          <label className="fg-caption flex flex-col gap-1">
            Assignee
            <InlineSelect
              native
              ariaLabel="Assignee"
              value={row.assigneeId ?? ""}
              options={assigneeOptions(members)}
              disabled={actions.isPending}
              onCommit={(uid) => actions.patch({ id: row.id, body: { assigneeId: uid === "" ? null : uid } })}
            />
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
