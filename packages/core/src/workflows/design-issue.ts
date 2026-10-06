/**
 * The issue a design is drawn under, and what the approver's decision does to it.
 *
 * Its proposer names it (`propose { issue }`, or `issue` on a write that proposes again); absent, a revision
 * inherits it from the one it supersedes while that issue is still open. It
 * is not a build link: a build waits on the approval, the design issue owes the drawing. So a return
 * hands the drawing back to that issue — reopened where its status allows, the reason posted on it —
 * and every decision wakes the project's master, which is what makes the issue admissible work again.
 */

import type { DesignStatus } from '@forge/contracts/design-status';
import { ISSUE_MACHINE, PARK_STATUSES, TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import { exitsOf } from '@forge/contracts/state-machine';
import { sql } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db, type Tx } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { transitionIssueStatus } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import type { DesignDecision } from './design.js';
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

/**
 * Whether the design issue stood at a park when the decision was made, read inside the decision's
 * transaction: a question that park waits on is answered there and may resume the issue before the
 * return is handed back, so the hand-back is decided by this reading and not by a later one.
 */
export async function parkedAtDecision(tx: Tx, designIssueId: string | null): Promise<boolean> {
  if (!designIssueId) return false;
  const rows = (await tx.execute(
    sql`SELECT status FROM issues WHERE id = ${designIssueId}`,
  )) as unknown as Array<{ status: IssueStatus }>;
  const status = rows[0]?.status;
  return status !== undefined && PARK_STATUSES.includes(status);
}

export async function settleDesignIssue(input: {
  projectId: string;
  flow: string;
  revision: number;
  decision: DesignDecision;
  reason: string | null;
  designIssueId: string | null;
  /** `parkedAtDecision`'s reading. */
  parked: boolean;
  decider: WorkflowWriter;
}): Promise<DesignIssueOutcome> {
  return input.decision === 'return'
    ? handBack(input)
    : { issueId: input.designIssueId, action: 'none', status: null };
}

async function handBack(input: {
  projectId: string;
  flow: string;
  revision: number;
  reason: string | null;
  designIssueId: string | null;
  parked: boolean;
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
  // a park returns only to the status it left, so `reopen` is not this move's to make there: a
  // question waiting on this revision was answered by the decision and resumes it
  const reopens =
    !input.parked &&
    !TAKEABLE_STATUSES.includes(status) &&
    !PARK_STATUSES.includes(status) &&
    exitsOf(ISSUE_MACHINE, status).includes('reopen');
  if (reopens) {
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
