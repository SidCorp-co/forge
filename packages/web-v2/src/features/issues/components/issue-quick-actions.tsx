"use client";

// IssueQuickActions (ISS-390) — a compact, always-visible quick-action row for
// the board quick-open drawer (the pipeline `RunDetail` SlideOver, the live

import { Button } from "@/design";
import { InlineSelect, StatusEdit } from "./inline-edit-cell";
import { PRIORITY_OPTIONS } from "./issue-table-row";
import { usePatchIssue, useTransitionIssue } from "../hooks";
import type { IssueAgentStatus, IssuePriority, IssueStatus } from "../types";

interface IssueQuickActionsProps {
  issueId: string;
  status: IssueStatus;
  agentStatus?: IssueAgentStatus;
  priority: IssuePriority;
  /** Project slug — enables the "Open issue" full-detail link when present. */
  slug?: string;
  /** Navigate to the full issue page (the host also closes the drawer). */
  onOpenIssue?: () => void;
}

/**
 * Pinned quick-action row for the run drawer. Inline status / priority
 * editing + "Open issue", reusing the list primitives so the mutation paths
 * (`usePatchIssue` / `useTransitionIssue`) and their cache invalidation are
 * shared — an edit here updates the board live exactly like editing a row.
 */
export function IssueQuickActions({
  issueId,
  status,
  agentStatus,
  priority,
  slug,
  onOpenIssue,
}: IssueQuickActionsProps) {
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
      {slug && onOpenIssue && (
        <Button variant="ghost" size="sm" icon="list" className="ml-auto" onClick={onOpenIssue}>
          Open issue
        </Button>
      )}
    </div>
  );
}
