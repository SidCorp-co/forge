"use client";

// IssueQuickActions (ISS-390) — a compact, always-visible quick-action row for
// the board quick-open drawer (the pipeline `RunDetail` SlideOver, the live
// `/projects/{slug}/issues` board surface). Surfaces the most-used issue
// mutations — status transition, priority, assignee — plus an "Open issue"
// full-detail link, all inline so a user can review + act without leaving the
// run drawer or scrolling. Composed entirely from the issues-list inline-edit
// primitives + mutation hooks, so behaviour (allowed-transition filtering,
// friendly 409 toasts) is byte-identical to the table/rail. No new API.

import { Avatar, Button } from "@/design";
import { InlineSelect, StatusEdit } from "./inline-edit-cell";
import { PRIORITY_OPTIONS, assigneeOptions } from "./issue-table-row";
import { usePatchIssue, useProjectMembers, useTransitionIssue } from "../hooks";
import { initials, memberLabel } from "../derive";
import type { IssueAgentStatus, IssuePriority, IssueStatus } from "../types";

interface IssueQuickActionsProps {
  issueId: string;
  projectId: string;
  status: IssueStatus;
  agentStatus?: IssueAgentStatus;
  priority: IssuePriority;
  assigneeId: string | null;
  /** Project slug — enables the "Open issue" full-detail link when present. */
  slug?: string;
  /** Navigate to the full issue page (the host also closes the drawer). */
  onOpenIssue?: () => void;
}

/**
 * Pinned quick-action row for the run drawer. Inline status / priority /
 * assignee editing + "Open issue", reusing the list primitives so the mutation
 * paths (`usePatchIssue` / `useTransitionIssue`) and their cache invalidation
 * are shared — an edit here updates the board live exactly like editing a row.
 */
export function IssueQuickActions({
  issueId,
  projectId,
  status,
  agentStatus,
  priority,
  assigneeId,
  slug,
  onOpenIssue,
}: IssueQuickActionsProps) {
  const membersQ = useProjectMembers(projectId);
  const patch = usePatchIssue();
  const transition = useTransitionIssue();
  const pending = patch.isPending || transition.isPending;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line-subtle bg-sunken px-3.5 py-2.5">
      <StatusEdit
        status={status}
        agentStatus={agentStatus}
        disabled={pending}
        size="sm"
        onTransition={(toStatus) => transition.mutate({ id: issueId, toStatus })}
      />
      <span aria-hidden className="h-4 w-px flex-none" style={{ background: "var(--border-default)" }} />
      <InlineSelect
        ariaLabel="Priority"
        value={priority}
        options={PRIORITY_OPTIONS}
        disabled={pending}
        onCommit={(p) => patch.mutate({ id: issueId, body: { priority: p as IssuePriority } })}
        className="w-32"
      />
      <div className="flex items-center gap-2">
        <Avatar initials={initials(memberLabel(assigneeId, membersQ.data))} size={22} />
        <InlineSelect
          ariaLabel="Assignee"
          value={assigneeId ?? ""}
          options={assigneeOptions(membersQ.data)}
          disabled={pending}
          onCommit={(uid) =>
            patch.mutate({ id: issueId, body: { assigneeId: uid === "" ? null : uid } })
          }
          className="w-36"
        />
      </div>
      {slug && onOpenIssue && (
        <Button variant="ghost" size="sm" icon="list" className="ml-auto" onClick={onOpenIssue}>
          Open issue
        </Button>
      )}
    </div>
  );
}
