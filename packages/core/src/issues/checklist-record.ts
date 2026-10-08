/**
 * What an issue's own record answers to the issue-ready checklist
 * (`@forge/contracts/checklist-registry:ISSUE_READY_CHECKLIST`, Issue lifecycle r12 ready-check). The
 * kernel calls it under the issue's row lock, through the move's transaction; it reads nothing else.
 */

import type { ChecklistId } from '@forge/contracts/checklist-registry';
import type { RecordAnswer, RecordAnswers } from '@forge/contracts/checklists';
import { requirementKey } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';

type Reader = Pick<Tx, 'execute'>;

const DELIVERABLE: readonly string[] = ['agreed', 'accepted'];

interface Planned {
  key: string | null;
  status: string | null;
  plannedRevision: number | null;
}

async function plannedOf(exec: Reader, issueId: string): Promise<Planned> {
  const rows = (await exec.execute(sql`
    SELECT r.req_seq, r.status, i.planned_revision
      FROM issues i LEFT JOIN requirements r ON r.id = i.requirement_id
     WHERE i.id = ${issueId}
  `)) as unknown as Array<{
    req_seq: number | null;
    status: string | null;
    planned_revision: number | null;
  }>;
  const row = rows[0];
  if (!row) throw new Error(`issue checklist: issue ${issueId} has no row to read`);
  return {
    key: row.req_seq === null ? null : requirementKey(row.req_seq),
    status: row.status,
    plannedRevision: row.planned_revision,
  };
}

function requirementAnswer(p: Planned): RecordAnswer {
  if (p.key === null) return { gap: 'This issue names no requirement.' };
  if (!DELIVERABLE.includes(p.status ?? '')) {
    return { gap: `${p.key} is ${p.status}, and an issue delivers only an agreed requirement.` };
  }
  if (p.plannedRevision === null) {
    return { gap: `It names ${p.key} and plans against no revision of it.` };
  }
  return { value: `${p.key} at revision ${p.plannedRevision}` };
}

async function criteriaAnswer(exec: Reader, issueId: string, p: Planned): Promise<RecordAnswer> {
  const rows = (await exec.execute(sql`
    SELECT c.n, rc.code,
           (rc.id IS NOT NULL
            AND rc.requirement_id = i.requirement_id
            AND rc.since_revision <= i.planned_revision
            AND (rc.retired_revision IS NULL OR rc.retired_revision > i.planned_revision)) AS traced
      FROM issue_criteria c
      JOIN issues i ON i.id = c.issue_id
      LEFT JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id
     WHERE c.issue_id = ${issueId} AND c.retired_at IS NULL
     ORDER BY c.position
  `)) as unknown as Array<{ n: number; code: string | null; traced: boolean | null }>;
  if (rows.length === 0) return { gap: 'This issue has no criteria.' };
  if (p.key === null || p.plannedRevision === null) {
    return { gap: 'Its criteria trace to no requirement revision, because it plans against none.' };
  }
  const untraced = rows.filter((r) => r.traced !== true).map((r) => r.n);
  if (untraced.length > 0) {
    return {
      gap: `Criteria ${untraced.join(', ')} trace to no BC that stands at ${p.key} revision ${p.plannedRevision}.`,
    };
  }
  const codes = [...new Set(rows.map((r) => r.code))].join(', ');
  return { value: `${rows.length} criteria, tracing ${codes} of ${p.key} revision ${p.plannedRevision}` };
}

async function designAnswer(exec: Reader, issueId: string): Promise<RecordAnswer> {
  const rows = (await exec.execute(sql`
    SELECT w.flow, w.revision, w.approved_revision
      FROM workflow_builds b JOIN project_workflows w ON w.id = b.workflow_id
     WHERE b.issue_id = ${issueId}
  `)) as unknown as Array<{ flow: string; revision: number; approved_revision: number | null }>;
  const row = rows[0];
  if (!row) return { value: 'None: it builds no workflow design.' };
  return {
    value:
      row.approved_revision === null
        ? `${row.flow} at revision ${row.revision}, not approved yet`
        : `${row.flow} revision ${row.approved_revision}`,
  };
}

async function issueReadyRecord(exec: Reader, issueId: string): Promise<RecordAnswers> {
  const planned = await plannedOf(exec, issueId);
  return {
    requirement: requirementAnswer(planned),
    criteria: await criteriaAnswer(exec, issueId, planned),
    design: await designAnswer(exec, issueId),
  };
}

/** The record answers of each checklist the issue machine names. */
export function issueChecklistRecord(
  exec: Reader,
  checklist: ChecklistId,
  issueId: string,
): Promise<RecordAnswers> {
  switch (checklist) {
    case 'issue_ready':
      return issueReadyRecord(exec, issueId);
    default: {
      const unhandled: never = checklist;
      throw new Error(`issue checklist: no record reader for checklist \`${unhandled as string}\``);
    }
  }
}
