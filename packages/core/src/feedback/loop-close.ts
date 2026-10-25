/**
 * Loop close, question two, read from the record for a person (Feedback lifecycle r14 loop-check;
 * Feedback triage r16): once nobody answered "is the problem gone?" within the project's window, the
 * record says what it holds: whether the item's violated criterion's latest verdict on the running
 * build passes and nothing was filed against that criterion since it read resolved. Either way the
 * item stays resolved for a holder of feedback.approve to answer (BC-1): the record informs that
 * answer and never gives it, so nothing verifies an item by itself.
 */

import { type FeedbackShipEvidence, feedbackKey } from '@forge/contracts/feedback';
import { type BcVerdict, requirementKey } from '@forge/contracts/requirements';
import { say, sayEn } from '@forge/contracts/said';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { type CriterionClip, criterionVerdictOf } from '../requirements/index.js';

export interface LoopCloseFacts {
  /** The criterion the triage named it violates, with its verdict now and the clip it cites; null where it named none. */
  criterion: {
    ref: string;
    verdict: BcVerdict | null;
    why: string | null;
    clip: CriterionClip | null;
  } | null;
  /** Items filed since it read resolved that may say the problem is back: against the criterion, or untriaged about its requirement. */
  filedSince: readonly string[];
  /** When it first read resolved. */
  resolvedSince: Date;
}

/** What the record reads, as one sentence a person answers from: `gone` where it reads the problem gone. */
export type RecordAnswer = { gone: boolean; why: string };

/** Whether the record reads the problem gone, with its sources, or why it cannot say. */
export function goneByRecord(f: LoopCloseFacts): RecordAnswer {
  if (!f.criterion) {
    return {
      gone: false,
      why: 'its triage named no criterion, so no verdict can say the problem is gone',
    };
  }
  const { ref, verdict, why } = f.criterion;
  if (verdict !== 'passing') {
    return {
      gone: false,
      why: `${ref} reads ${verdict ?? 'no verdict'} on the running build${why ? ` (${why})` : ''}`,
    };
  }
  if (f.filedSince.length > 0) {
    return {
      gone: false,
      why: `${f.filedSince.join(', ')} ${f.filedSince.length === 1 ? 'was' : 'were'} filed against ${ref} since it read resolved`,
    };
  }
  return {
    gone: true,
    why: `the record reads it gone: ${ref} passes on the running build, and nothing was filed against it since ${f.resolvedSince.toISOString().slice(0, 10)}.`,
  };
}

/** The named criterion as the record reads it now: its key, verdict, why and clip; null where none is named. */
async function criterionNow(
  projectId: string,
  criterionId: string | null,
): Promise<(NonNullable<LoopCloseFacts['criterion']> & { requirementId: string }) | null> {
  if (!criterionId) return null;
  const found = (await db.execute(sql`
    SELECT c.requirement_id, c.code, r.req_seq
      FROM requirement_criteria c JOIN requirements r ON r.id = c.requirement_id
     WHERE c.id = ${criterionId}
  `)) as unknown as Array<{ requirement_id: string; code: string; req_seq: number }>;
  const c = found[0];
  if (!c) return null;
  const verdict = await criterionVerdictOf(projectId, c.requirement_id, c.code);
  return {
    requirementId: c.requirement_id,
    ref: `${requirementKey(Number(c.req_seq))} ${c.code}`,
    verdict: verdict?.verdict ?? null,
    why: verdict?.why ?? null,
    clip: verdict?.clip ?? null,
  };
}

/**
 * What the reporter of a shipped fix is shown when asked to confirm it (REQ-66 BC-8): the violated
 * criterion's verdict on the running build and the clip its counting verdict cites, never only the
 * release note's words.
 */
export async function shipEvidenceOf(row: {
  projectId: string;
  violatedCriterionId: string | null;
}): Promise<FeedbackShipEvidence> {
  const c = await criterionNow(row.projectId, row.violatedCriterionId);
  const reads = !c
    ? say('feedback.evidence.noCriterion')
    : c.verdict === 'passing'
      ? say('feedback.evidence.passes', { ref: c.ref })
      : say('feedback.evidence.notYet', { ref: c.ref });
  return {
    criterion: c?.ref ?? null,
    verdict: c?.verdict ?? null,
    why: c && c.verdict !== 'passing' ? c.why : null,
    clip: c?.clip ?? null,
    reads: sayEn(reads),
    says: { reads },
  };
}

/** What the record holds for one resolved item: its criterion's verdict, and what was filed since. */
export async function loopCloseFactsOf(row: {
  id: string;
  projectId: string;
  violatedCriterionId: string | null;
  resolvedSeenAt: Date;
}): Promise<LoopCloseFacts> {
  const found = await criterionNow(row.projectId, row.violatedCriterionId);
  if (!found) return { criterion: null, filedSince: [], resolvedSince: row.resolvedSeenAt };
  const { requirementId, ...criterion } = found;
  const since = (await db.execute(sql`
    SELECT fb_seq FROM feedback
     WHERE project_id = ${row.projectId} AND id <> ${row.id}
       AND created_at > ${row.resolvedSeenAt.toISOString()}
       AND (violated_criterion_id = ${row.violatedCriterionId}
            OR (requirement_id = ${requirementId} AND status IN ('new', 'reopened')))
     ORDER BY fb_seq
  `)) as unknown as Array<{ fb_seq: number }>;
  return {
    criterion,
    filedSince: since.map((s) => feedbackKey(Number(s.fb_seq))),
    resolvedSince: row.resolvedSeenAt,
  };
}

/** What the reporter of one item is shown of its shipped fix; null before its work shipped. */
export async function shipEvidenceOfShipped(
  projectId: string,
  feedbackId: string,
  phase: string,
): Promise<FeedbackShipEvidence | null> {
  if (phase !== 'resolved' && phase !== 'verified') return null;
  const [row] = await db
    .select({ violatedCriterionId: feedback.violatedCriterionId, route: feedback.route })
    .from(feedback)
    .where(and(eq(feedback.projectId, projectId), eq(feedback.id, feedbackId)));
  if (row?.route !== 'issue') return null;
  return shipEvidenceOf({ projectId, violatedCriterionId: row.violatedCriterionId });
}
