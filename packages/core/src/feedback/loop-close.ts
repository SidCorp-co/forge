/**
 * Loop close, question two, answered from the record (Feedback lifecycle r14 loop-check; Feedback
 * triage r16 auto-verify): once nobody answered "is the problem gone?" within the project's window,
 * the item is verified only where its violated criterion's latest verdict on the running build passes
 * and nothing was filed against that criterion since it read resolved. Anything else leaves it
 * resolved for a person to answer (BC-1): it is never assumed gone.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { type BcVerdict, requirementKey } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { criterionVerdictOf } from '../requirements/index.js';

export interface LoopCloseFacts {
  /** The criterion the triage named it violates, with its verdict now; null where it named none. */
  criterion: { ref: string; verdict: BcVerdict | null; why: string | null } | null;
  /** Items filed since it read resolved that may say the problem is back: against the criterion, or untriaged about its requirement. */
  filedSince: readonly string[];
  /** When it first read resolved. */
  resolvedSince: Date;
}

export type RecordAnswer = { gone: true; reason: string } | { gone: false; why: string };

/** Whether the record says the problem is gone, with its sources, or why it cannot say. */
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
    reason: `Verified from the record: ${ref} passes on the running build, and nothing was filed against it since ${f.resolvedSince.toISOString().slice(0, 10)}.`,
  };
}

/** What the record holds for one resolved item: its criterion's verdict, and what was filed since. */
export async function loopCloseFactsOf(row: {
  id: string;
  projectId: string;
  violatedCriterionId: string | null;
  resolvedSeenAt: Date;
}): Promise<LoopCloseFacts> {
  if (!row.violatedCriterionId) {
    return { criterion: null, filedSince: [], resolvedSince: row.resolvedSeenAt };
  }
  const found = (await db.execute(sql`
    SELECT c.requirement_id, c.code, r.req_seq
      FROM requirement_criteria c JOIN requirements r ON r.id = c.requirement_id
     WHERE c.id = ${row.violatedCriterionId}
  `)) as unknown as Array<{ requirement_id: string; code: string; req_seq: number }>;
  const c = found[0];
  if (!c) return { criterion: null, filedSince: [], resolvedSince: row.resolvedSeenAt };
  const verdict = await criterionVerdictOf(row.projectId, c.requirement_id, c.code);
  const since = (await db.execute(sql`
    SELECT fb_seq FROM feedback
     WHERE project_id = ${row.projectId} AND id <> ${row.id}
       AND created_at > ${row.resolvedSeenAt.toISOString()}
       AND (violated_criterion_id = ${row.violatedCriterionId}
            OR (requirement_id = ${c.requirement_id} AND status IN ('new', 'reopened')))
     ORDER BY fb_seq
  `)) as unknown as Array<{ fb_seq: number }>;
  return {
    criterion: {
      ref: `${requirementKey(Number(c.req_seq))} ${c.code}`,
      verdict: verdict?.verdict ?? null,
      why: verdict?.why ?? null,
    },
    filedSince: since.map((s) => feedbackKey(Number(s.fb_seq))),
    resolvedSince: row.resolvedSeenAt,
  };
}
