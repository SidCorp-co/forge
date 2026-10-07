"use client";

// IssueQuickActions (ISS-390) — a compact, always-visible quick-action row for
// the board quick-open drawer (the pipeline `RunDetail` SlideOver, the live

import type { IssueMove } from "@forge/contracts/issue-machine";
import type { WorkStep } from "@forge/contracts/issue-vocabulary";
import { Button, StatusChip } from "@/design";
import { useId } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { runStatusChip } from "../derive";
import { agentHoldsEdit, heldByAgent } from "../edit-lock";
import { InlineSelect, StatusEdit } from "./inline-edit-cell";
import { usePriorityOptions } from "./issue-table-row";
import { usePatchIssue } from "../hooks";
import { useGuardedTransition } from "./use-guarded-transition";
import type { IssueAgentStatus, IssuePriority, IssueStatus, PipelineHealth } from "../types";

interface IssueQuickActionsProps {
  issueId: string;
  status: IssueStatus;
  /** The run's step inside `in_progress`, named on the status chip. */
  step?: WorkStep | null;
  /** Core's moves from this status. */
  moves: readonly IssueMove[];
  agentStatus?: IssueAgentStatus;
  /** The issue's pipeline health — a job queued before any runner claims it is a queued run. */
  pipelineHealth?: PipelineHealth;
  priority: IssuePriority;
  /** Project slug — enables the "Open issue" full-detail link when present. */
  slug?: string;
  /** Navigate to the full issue page (the host also closes the drawer). */
  onOpenIssue?: () => void;
}

export function IssueQuickActions({
  issueId,
  status,
  step,
  moves,
  agentStatus,
  pipelineHealth,
  priority,
  slug,
  onOpenIssue,
}: IssueQuickActionsProps) {
  const patch = usePatchIssue();
  const { requestTransition, dialog, isPending } = useGuardedTransition();
  const pending = patch.isPending || isPending;
  const runChip = runStatusChip({ agentStatus, pipelineHealth });
  const refusalId = useId();
  const t = useCopy();
  const priorityOptions = usePriorityOptions();
  const refusal = heldByAgent(status, agentStatus) ? { id: refusalId, text: agentHoldsEdit(t) } : null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line-subtle bg-sunken px-3.5 py-2.5">
      {dialog}
      <StatusEdit
        status={status}
        step={step}
        moves={moves}
        agentStatus={agentStatus}
        disabled={pending}
        size="sm"
        onTransition={(toStatus) => requestTransition(issueId, toStatus)}
      />
      {runChip && <StatusChip status={runChip} size="sm" domain="session" />}
      <span aria-hidden className="h-4 w-px flex-none" style={{ background: "var(--border-default)" }} />
      <InlineSelect
        ariaLabel={t("issues.field.priority")}
        value={priority}
        options={priorityOptions}
        disabled={pending}
        refusal={refusal}
        onCommit={(p) => patch.mutate({ id: issueId, body: { priority: p as IssuePriority } })}
        className="w-32"
      />
      {slug && onOpenIssue && (
        <Button variant="ghost" size="sm" icon="list" className="ml-auto" onClick={onOpenIssue}>
          {t("issues.row.open")}
        </Button>
      )}
      {refusal && (
        <p id={refusal.id} role="status" className="fg-caption basis-full text-subtle">
          {refusal.text}
        </p>
      )}
    </div>
  );
}
