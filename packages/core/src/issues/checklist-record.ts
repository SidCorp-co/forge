/**
 * What an issue's own record answers to the issue-ready checklist
 * (`@forge/contracts/checklist-registry:ISSUE_READY_CHECKLIST`, Issue lifecycle r12 ready-check). The
 * kernel calls it under the issue's row lock, through the move's transaction; it reads nothing else.
 */

import type { ChecklistId } from '@forge/contracts/checklist-registry';
import type { RecordAnswer, RecordAnswers } from '@forge/contracts/checklists';
import { AGREED_STATUSES, requirementKey } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { strayTraceTagsOf } from './criteria/criteria-text.js';

type Reader = Pick<Tx, 'execute'>;

const DELIVERABLE: readonly string[] = AGREED_STATUSES;

export interface Planned {
  key: string | null;
  status: string | null;
  /** The revision the issue's plan was written against; null where no plan names one. */
  plannedRevision: number | null;
  /** The requirement's current revision: the one a plan not written yet is written against. */
  currentRevision: number | null;
}

/**
 * The revision the issue plans against (Issue lifecycle ready-check, item 1): its plan's, else the
 * requirement's current one. The plan is the run's to write once it claims the open issue, so a
 * draft is never asked for one (ISS-778); the move into build asks for it (`plan-checkpoint.ts:unplannedForBuild`).
 */
export const plannedAgainst = (p: Planned): number | null => p.plannedRevision ?? p.currentRevision;

async function plannedOf(exec: Reader, issueId: string): Promise<Planned> {
  const rows = (await exec.execute(sql`
    SELECT r.req_seq, r.status, i.planned_revision, r.current_revision
      FROM issues i LEFT JOIN requirements r ON r.id = i.requirement_id
     WHERE i.id = ${issueId}
  `)) as unknown as Array<{
    req_seq: number | null;
    status: string | null;
    planned_revision: number | null;
    current_revision: number | null;
  }>;
  const row = rows[0];
  if (!row) throw new Error(`issue checklist: issue ${issueId} has no row to read`);
  return {
    key: row.req_seq === null ? null : requirementKey(row.req_seq),
    status: row.status,
    plannedRevision: row.planned_revision,
    currentRevision: row.current_revision,
  };
}

// Every sentence here is read by a person: the kernel refuses to judge with one that shows a record
// field's key (`@forge/contracts/checklists:fieldKeyShownIn`), and `checklist-record.test.ts`
// reads each one this reader can write.
export function requirementAnswer(p: Planned): RecordAnswer {
  if (p.key === null) {
    return {
      gap: 'The issue is not linked to a requirement.',
      fix: 'Link it to the agreed requirement it delivers.',
    };
  }
  if (!DELIVERABLE.includes(p.status ?? '')) {
    return {
      gap: `It is linked to ${p.key}, which is ${p.status}, and an issue can deliver only an agreed or accepted requirement.`,
      fix: `Wait until ${p.key} is agreed, or link the issue to the agreed requirement it delivers instead.`,
    };
  }
  if (p.plannedRevision !== null) return { value: `${p.key} at revision ${p.plannedRevision}` };
  if (p.currentRevision === null) {
    return {
      gap: `It is linked to ${p.key}, which has no current revision yet.`,
      fix: `A person accepts a revision of ${p.key} first.`,
    };
  }
  return {
    value: `${p.key} at revision ${p.currentRevision}, its current one, which the run's plan is written against`,
  };
}

const criteriaCount = (n: number) => `${n} ${n === 1 ? 'criterion' : 'criteria'}`;

/**
 * One live criterion of the issue: its number, the BC it traces, whether that BC stands at the
 * planned revision, and whether its words name a BC tag after the start of the line, which traces
 * nothing (ISS-625).
 */
export interface CriterionTrace {
  n: number;
  code: string | null;
  traced: boolean | null;
  strayTag?: boolean;
}

async function criteriaAnswer(exec: Reader, issueId: string, p: Planned): Promise<RecordAnswer> {
  const rows = (await exec.execute(sql`
    SELECT c.n, rc.code, c.statement,
           (rc.id IS NOT NULL
            AND rc.requirement_id = i.requirement_id
            AND rc.since_revision <= COALESCE(i.planned_revision, r.current_revision)
            AND (rc.retired_revision IS NULL
                 OR rc.retired_revision > COALESCE(i.planned_revision, r.current_revision))) AS traced
      FROM issue_criteria c
      JOIN issues i ON i.id = c.issue_id
      LEFT JOIN requirements r ON r.id = i.requirement_id
      LEFT JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id
     WHERE c.issue_id = ${issueId} AND c.retired_at IS NULL
     ORDER BY c.position
  `)) as unknown as Array<CriterionTrace & { statement: string }>;
  return criteriaAnswerOf(
    rows.map(({ statement, ...row }) => ({
      ...row,
      strayTag: strayTraceTagsOf(statement).length > 0,
    })),
    p,
  );
}

export function criteriaAnswerOf(rows: readonly CriterionTrace[], p: Planned): RecordAnswer {
  if (rows.length === 0) {
    return {
      gap: 'The issue has no acceptance criteria.',
      fix: 'Write numbered criteria, each traced to a business criterion of that revision.',
    };
  }
  const revision = p.key === null ? null : plannedAgainst(p);
  if (p.key === null || revision === null) {
    return {
      gap: `Its ${criteriaCount(rows.length)} cannot be traced yet, because the issue is linked to no requirement revision.`,
      fix: 'Answer the requirement question first; then trace each criterion to a business criterion (BC) of that revision.',
    };
  }
  const untraced = rows.filter((r) => r.traced !== true);
  if (untraced.length > 0) {
    const one = untraced.length === 1;
    const stray = untraced.filter((r) => r.strayTag === true).map((r) => r.n);
    const strayOne = stray.length === 1;
    const strayGap =
      stray.length === 0
        ? ''
        : ` ${strayOne ? 'Criterion' : 'Criteria'} ${stray.join(', ')} ${strayOne ? 'names its' : 'name their'} BC after the start of ${strayOne ? 'its line' : 'their lines'}, which traces nothing.`;
    return {
      gap: `${one ? 'Criterion' : 'Criteria'} ${untraced.map((r) => r.n).join(', ')} ${one ? 'is' : 'are'} not traced to a business criterion (BC) that stands at ${p.key} revision ${revision}.${strayGap}`,
      fix: `Start ${one ? 'its line' : 'each line'} with the BC it proves, as "(${p.key} BC-<m>) <statement>"; a BC tag anywhere else in the line traces nothing.`,
    };
  }
  const codes = [...new Set(rows.map((r) => r.code))].join(', ');
  return {
    value: `${criteriaCount(rows.length)}, tracing ${codes} of ${p.key} revision ${revision}`,
  };
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
    case 'feedback_triage':
    case 'requirement_ready':
    case 'requirement_acceptance':
    case 'workflow_approval':
    case 'breakdown':
      throw new Error(
        `issue checklist: \`${checklist}\` gates another machine, whose reader is its own module's`,
      );
    default: {
      const unhandled: never = checklist;
      throw new Error(`issue checklist: no record reader for checklist \`${unhandled as string}\``);
    }
  }
}
