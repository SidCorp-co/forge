// The issues owing their independent judge's review (ISS-870, FB-433): where the project's gate
// profile declares an independent judge (`@forge/contracts/verified-rule:verifiedJudgeOf`, strict
// alone since ISS-845, or standard with `qa: independent`), an issue at `in_progress` on its test
// step, or at `awaiting_release`, whose live criteria the verified rule does not hold proven waits on
// that judge, and nothing but the master declares one. It is master work (`masters/owed.ts`), so an
// outdated pane owing only a review is replaced rather than left draining with nothing placed.
// An issue a run, job or lease already works is not owed, as the admissible list reads it
// (`issue-lease.ts:issueWorkInFlightSql`). An issue with no live criterion owes no judgement.

import { type VerifiedJudge, verifiedOf } from '@forge/contracts/verified-rule';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type AuthoredVerdict, liveVerdictsOfIssues } from './criteria/live-verdicts.js';
import { issueWorkInFlightSql } from './issue-lease.js';
import { activeIssuePrefix } from './issue-prefix-read.js';

/** An issue waiting on its independent judge, and the criteria the verified rule does not hold proven. */
export interface ReviewOwed {
  issueId: string;
  key: string;
  /** `in_progress` stands for the issue at its test step. */
  status: 'in_progress' | 'awaiting_release';
  criteria: number[];
}

/**
 * Of an issue's live criterion numbers, those the verified rule does not hold proven under `judge`,
 * each read from its verdicts newest first: none recorded, the builder's own pass, an unauthored pass,
 * a short or a fail. Pure.
 */
export function unprovenCriteria(
  numbers: readonly number[],
  verdicts: ReadonlyMap<number, readonly AuthoredVerdict[]>,
  judge: VerifiedJudge,
): number[] {
  return numbers.filter((n) => !verifiedOf(verdicts.get(n) ?? [], judge).proven);
}

/** The reviews `projectId` owes its independent judge; none where its profile declares no such judge. */
export async function owedReviews(projectId: string, judge: VerifiedJudge): Promise<ReviewOwed[]> {
  if (judge !== 'independent') return [];
  const rows = (await db.execute(sql`
    SELECT i.id, i.iss_seq, i.status,
           ARRAY(SELECT c.n FROM issue_criteria c
                  WHERE c.issue_id = i.id AND c.retired_at IS NULL ORDER BY c.n) AS criteria
      FROM issues i
     WHERE i.project_id = ${projectId}::uuid
       AND (i.status = 'awaiting_release'
            OR (i.status = 'in_progress' AND EXISTS (
                  SELECT 1 FROM issue_work_state w WHERE w.issue_id = i.id AND w.step = 'test')))
       AND NOT ${issueWorkInFlightSql({
         issueId: sql`i.id`,
         projectId: sql`i.project_id`,
         issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
       })}
     ORDER BY i.iss_seq
  `)) as unknown as Array<{
    id: string;
    iss_seq: number;
    status: ReviewOwed['status'];
    criteria: number[] | null;
  }>;
  const judged = rows.filter((r) => (r.criteria ?? []).length > 0);
  if (judged.length === 0) return [];
  const verdicts = await liveVerdictsOfIssues(
    db,
    judged.map((r) => r.id),
  );
  const prefix = await activeIssuePrefix(projectId);
  return judged.flatMap((r) => {
    const criteria = unprovenCriteria(
      (r.criteria ?? []).map(Number),
      verdicts.get(r.id) ?? new Map(),
      judge,
    );
    return criteria.length === 0
      ? []
      : [{ issueId: r.id, key: formatIssueRef(prefix, r.iss_seq), status: r.status, criteria }];
  });
}
