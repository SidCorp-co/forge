/**
 * The issue a design is drawn under, and what the approver's decision does to it.
 *
 * Its proposer names it (`propose { issue }`), and a revision a write proposes again inherits it. It
 * is not a build link: a build waits on the approval, the design issue owes the drawing. So a return
 * hands the drawing back to that issue — reopened where its status allows, the reason posted on it —
 * and every decision wakes the project's master, which is what makes the issue admissible work again.
 */

import { ISSUE_MACHINE, TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import { exitsOf } from '@forge/contracts/state-machine';
import { sql } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { transitionIssueStatus } from '../issues/index.js';
import { logger } from '../observability/logger.js';
import { emitEvent } from '../outbox/index.js';
import type { DesignDecision, DesignStatus } from './design.js';
import type { WorkflowWriter } from './service.js';

/** What happened to the design issue, so the decision's answer says it rather than leaving it to a guess. */
export interface DesignIssueOutcome {
  issueId: string | null;
  action: 'none' | 'reopened' | 'commented';
  status: IssueStatus | null;
}

function returnedBody(args: { flow: string; revision: number; reason: string }): string {
  return `Design \`${args.flow}\` revision ${args.revision} was returned by its approver:\n\n> ${args.reason.replace(/\n/g, '\n> ')}\n\nRevise the design by writing it again, which proposes the revision.`;
}

export async function settleDesignIssue(input: {
  projectId: string;
  workflowId: string;
  flow: string;
  revision: number;
  decision: DesignDecision;
  reason: string | null;
  designIssueId: string | null;
  decider: WorkflowWriter;
}): Promise<DesignIssueOutcome> {
  const outcome: DesignIssueOutcome =
    input.decision === 'return'
      ? await handBack(input)
      : { issueId: input.designIssueId, action: 'none', status: null };
  await emitEvent(db, 'workflow.designDecided', {
    projectId: input.projectId,
    workflowId: input.workflowId,
    decision: input.decision,
    issueId: input.designIssueId,
  });
  return outcome;
}

async function handBack(input: {
  projectId: string;
  flow: string;
  revision: number;
  reason: string | null;
  designIssueId: string | null;
  decider: WorkflowWriter;
}): Promise<DesignIssueOutcome> {
  if (!input.designIssueId) return { issueId: null, action: 'none', status: null };
  const rows = (await db.execute(sql`
    SELECT id, project_id, status, reopen_count FROM issues
    WHERE id = ${input.designIssueId} AND archived_at IS NULL
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return { issueId: null, action: 'none', status: null };
  const status = String(row.status) as IssueStatus;
  const body = returnedBody({
    flow: input.flow,
    revision: input.revision,
    reason: input.reason ?? '',
  });
  const actor = { type: 'user' as const, id: input.decider.userId, agency: input.decider.agency };
  if (!TAKEABLE_STATUSES.includes(status) && exitsOf(ISSUE_MACHINE, status).includes('reopen')) {
    const moved = await transitionIssueStatus(
      {
        id: String(row.id),
        projectId: String(row.project_id),
        status,
        reopenCount: Number(row.reopen_count ?? 0),
      },
      'reopen',
      actor,
      { transitionReason: body, reason: 'workflow_design_returned' },
    );
    return { issueId: String(row.id), action: 'reopened', status: moved.status };
  }
  // Already takeable, being worked, or parked by a person: the status stays theirs, the reason is
  // still posted where the issue read shows it.
  await postIssueNotice({ issueId: String(row.id), authorId: input.decider.userId, body });
  logger.info(
    { issueId: row.id, status },
    'workflow design returned: its issue keeps its status, the reason is posted on it',
  );
  return { issueId: String(row.id), action: 'commented', status };
}

/** What `GET /issues/:id` shows of a proposing issue: its workflow and its latest proposed revision, with that revision's decision. */
export async function proposesWorkflowOf(issueId: string) {
  const rows = (await db.execute(sql`
    SELECT w.id, w.flow, w.design_status, w.approved_revision,
           w.document->>'title' AS title,
           d.revision, d.decision, d.reason, d.decided_at
    FROM project_workflow_designs d
    JOIN project_workflows w ON w.id = d.workflow_id
    WHERE d.design_issue_id = ${issueId}
    ORDER BY d.proposed_at DESC, d.revision DESC
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    workflowId: String(row.id),
    flow: String(row.flow),
    title: (row.title as string | null) ?? String(row.flow),
    designStatus: (row.design_status as DesignStatus | null) ?? null,
    approvedRevision: row.approved_revision == null ? null : Number(row.approved_revision),
    revision: Number(row.revision),
    decision: (row.decision as DesignDecision | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    decidedAt: row.decided_at == null ? null : new Date(row.decided_at as string).toISOString(),
  };
}
