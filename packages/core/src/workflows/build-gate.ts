/**
 * The build gate: an issue that names the workflow it builds is not dispatched until that
 * workflow's design is approved (`design.ts:designNotApproved`).
 *
 * One predicate, asked three ways: the admissible list leaves such an issue out, a run session
 * opening over it is refused by name, and a job claimed for it is refused by name. The issue read
 * says why (`buildsWorkflowOf`), so a master that cannot take it is told what it waits on.
 */

import type { DesignStatus } from '@forge/contracts/design-status';
import { type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { idList } from '../db/raw-sql.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { designNotApproved, designNotApprovedDetail } from './design.js';

export function designUnapprovedSql(issueId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM workflow_builds wb
    JOIN project_workflows w ON w.id = wb.workflow_id
    WHERE wb.issue_id = ${issueId}
      AND w.design_status IS DISTINCT FROM 'approved'
  )`;
}

interface Blocked {
  issueId: string;
  issSeq: number;
  workflowId: string;
  flow: string;
  status: DesignStatus | null;
}

/** Where a gate reads: the root `db`, or the transaction of a move that asks it under its lock. */
export type GateReader = Pick<Tx, 'execute' | 'select'>;

async function blockedWhere(
  projectId: string,
  filter: SQL,
  executor: GateReader = db,
): Promise<Blocked[]> {
  const rows = (await executor.execute(sql`
    SELECT i.id AS issue_id, i.iss_seq, w.id AS workflow_id, w.flow, w.design_status
    FROM workflow_builds wb
    JOIN issues i ON i.id = wb.issue_id
    JOIN project_workflows w ON w.id = wb.workflow_id
    WHERE wb.project_id = ${projectId}
      AND w.design_status IS DISTINCT FROM 'approved'
      AND ${filter}
    ORDER BY i.iss_seq
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    issueId: String(r.issue_id),
    issSeq: Number(r.iss_seq),
    workflowId: String(r.workflow_id),
    flow: String(r.flow),
    status: (r.design_status as DesignStatus | null) ?? null,
  }));
}

async function refuseBlocked(
  projectId: string,
  blocked: Blocked[],
  executor: GateReader = db,
): Promise<void> {
  if (blocked.length === 0) return;
  throw refusalOf(await activeIssuePrefix(projectId, executor), blocked);
}

const refusalOf = (prefix: string | null, blocked: readonly Blocked[]) =>
  designNotApproved(
    blocked.map((b) => ({
      issue: formatIssueRef(prefix, b.issSeq),
      workflowId: b.workflowId,
      flow: b.flow,
      status: b.status,
    })),
  );

/**
 * Why the gate holds each of these issues, by issue id: the detail of the refusal a dispatch door
 * would give it, every issue read in one query. An issue the gate does not hold is absent.
 */
export async function designHoldsOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const blocked = await blockedWhere(projectId, sql`i.id IN (${idList(issueIds)})`);
  if (blocked.length === 0) return new Map();
  const prefix = await activeIssuePrefix(projectId);
  const byIssue = new Map<string, Blocked[]>();
  for (const b of blocked) byIssue.set(b.issueId, [...(byIssue.get(b.issueId) ?? []), b]);
  return new Map(
    [...byIssue].map(([id, held]) => [
      id,
      refusalOf(prefix, held)
        .refusals.map((r) => r.detail)
        .join(' '),
    ]),
  );
}

/** Refuses a run over these issues (by sequence number) while any builds an unapproved design. */
export async function assertDesignsApprovedForSeqs(
  projectId: string,
  seqs: readonly number[],
): Promise<void> {
  if (seqs.length === 0) return;
  const list = sql.join(
    seqs.map((n) => sql`${n}`),
    sql`, `,
  );
  await refuseBlocked(projectId, await blockedWhere(projectId, sql`i.iss_seq IN (${list})`));
}

export async function assertDesignApprovedForIssue(
  projectId: string,
  issueId: string,
  executor: GateReader = db,
): Promise<void> {
  await refuseBlocked(
    projectId,
    await blockedWhere(projectId, sql`i.id = ${issueId}`, executor),
    executor,
  );
}

/** The issue read's answer: which workflow it builds, and whether that lets it be dispatched. */
export async function buildsWorkflowOf(issueId: string) {
  const rows = (await db.execute(sql`
    SELECT w.id, w.flow, w.project_id, w.design_status, w.approved_revision, i.iss_seq,
           w.document->>'title' AS title
    FROM workflow_builds wb
    JOIN project_workflows w ON w.id = wb.workflow_id
    JOIN issues i ON i.id = wb.issue_id
    WHERE wb.issue_id = ${issueId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  const status = (row.design_status as DesignStatus | null) ?? null;
  const approved = status === 'approved';
  const issue = formatIssueRef(
    await activeIssuePrefix(String(row.project_id)),
    Number(row.iss_seq),
  );
  return {
    workflowId: String(row.id),
    flow: String(row.flow),
    title: (row.title as string | null) ?? String(row.flow),
    designStatus: status,
    approvedRevision: row.approved_revision == null ? null : Number(row.approved_revision),
    dispatchable: approved,
    refusal: approved
      ? null
      : {
          code: 'WORKFLOW_DESIGN_NOT_APPROVED' as const,
          detail: designNotApprovedDetail({
            issue,
            workflowId: String(row.id),
            flow: String(row.flow),
            status,
          }),
        },
  };
}
