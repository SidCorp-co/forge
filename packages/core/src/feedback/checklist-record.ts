/**
 * What a feedback item's own record answers to the triage checklist
 * (`@forge/contracts/checklist-registry:FEEDBACK_TRIAGE_CHECKLIST`, Feedback lifecycle r14
 * triage-check): its kind, and the requirement it is about. The triage writes a corrected kind and
 * the criterion it names before the move, and the kernel calls this under the row lock through the
 * move's transaction, so the answers are the item as the triage leaves it.
 */

import { FEEDBACK_TRIAGE_CHECKLIST } from '@forge/contracts/checklist-registry';
import type { ChecklistEvaluation, RecordAnswer, RecordAnswers } from '@forge/contracts/checklists';
import { FEEDBACK_SEVERITY_LABELS, type FeedbackSeverity } from '@forge/contracts/feedback';
import { requirementKey } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';

type Reader = Pick<Tx, 'execute'>;

export interface TriageRecordRow {
  kind: string;
  /** The requirement it targets, or its target issue's. */
  targetSeq: number | null;
  /** The requirement of the criterion its triage named it violates. */
  criterionSeq: number | null;
}

/** The requirement answer: its target's requirement, else the one whose criterion it violates, else none. */
export function requirementAnswerOf(row: TriageRecordRow): RecordAnswer {
  if (row.targetSeq !== null) return { value: requirementKey(row.targetSeq) };
  if (row.criterionSeq !== null) {
    return { value: `${requirementKey(row.criterionSeq)}, whose criterion it violates` };
  }
  return { value: 'None: it is about no requirement.' };
}

export function triageRecordOf(row: TriageRecordRow): RecordAnswers {
  return { kind: { value: row.kind }, requirement: requirementAnswerOf(row) };
}

export async function feedbackTriageRecord(
  exec: Reader,
  feedbackId: string,
): Promise<RecordAnswers> {
  const rows = (await exec.execute(sql`
    SELECT f.kind,
           COALESCE(tr.req_seq, ir.req_seq) AS target_seq,
           cr.req_seq AS criterion_seq
      FROM feedback f
      LEFT JOIN requirements tr ON tr.id = f.requirement_id
      LEFT JOIN issues i ON i.id = f.issue_id
      LEFT JOIN requirements ir ON ir.id = i.requirement_id
      LEFT JOIN requirement_criteria c ON c.id = f.violated_criterion_id
      LEFT JOIN requirements cr ON cr.id = c.requirement_id
     WHERE f.id = ${feedbackId}
  `)) as unknown as Array<{
    kind: string;
    target_seq: number | null;
    criterion_seq: number | null;
  }>;
  const row = rows[0];
  if (!row) throw new Error(`feedback checklist: item ${feedbackId} has no row to read`);
  return triageRecordOf({
    kind: row.kind,
    targetSeq: row.target_seq === null ? null : Number(row.target_seq),
    criterionSeq: row.criterion_seq === null ? null : Number(row.criterion_seq),
  });
}

const SEVERITY_PROMPT = FEEDBACK_TRIAGE_CHECKLIST.questions.find(
  (q) => q.id === 'severity',
)?.prompt;

/**
 * The item as it stands for a reader: severity is the triage's to give, so it stays a gap until one
 * does, but the gap names the severity the item was reported with rather than saying it has none.
 */
export function withReportedSeverity(
  now: ChecklistEvaluation,
  severity: FeedbackSeverity,
): ChecklistEvaluation {
  return {
    ...now,
    gaps: now.gaps.map((g) =>
      g.question === 'severity'
        ? {
            ...g,
            detail: `${SEVERITY_PROMPT} Reported as ${FEEDBACK_SEVERITY_LABELS[severity]}; the triage confirms it or picks another.`,
          }
        : g,
    ),
  };
}
