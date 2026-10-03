// cm:seam ISS-55 — every criterion's latest verdict, the evidence `awaiting_release` stands on, read
// from `acceptanceCriteria` and verdict fences today; ISS-55 swaps in `criterion_verdicts` behind
// this answer's shape, so `transition-guards.ts:verdictGuard` does not move.

import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { acceptanceCriteriaNumbers, latestCriterionVerdicts } from './criteria-verdicts.js';

/** As the release gate counts them (`criteria-verdicts.ts:EARNED_VERDICTS`). */
const PASSING: ReadonlySet<string> = new Set(['pass', 'short']);

export type CriteriaEvidence =
  | { kind: 'no-criteria' }
  | {
      kind: 'criteria';
      unpassed: Array<{ criterion: number; verdict: string | null }>;
      /** Passing criteria whose latest verdict names no commit, runtime or design revision. */
      unidentified: number[];
    };

export async function unpassedCriteria(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
): Promise<CriteriaEvidence> {
  const rows = (await executor.execute(sqlCriteria(issueId))) as unknown as Array<{
    acceptance_criteria: string | null;
  }>;
  const numbers = acceptanceCriteriaNumbers(rows[0]?.acceptance_criteria ?? null);
  if (numbers.length === 0) return { kind: 'no-criteria' };
  const latest = await latestCriterionVerdicts(issueId);
  const unpassed: Array<{ criterion: number; verdict: string | null }> = [];
  const unidentified: number[] = [];
  for (const criterion of numbers) {
    const verdict = latest.get(criterion);
    if (!verdict || !PASSING.has(verdict.verdict)) {
      unpassed.push({ criterion, verdict: verdict?.verdict ?? null });
      continue;
    }
    if (verdict.at === null) unidentified.push(criterion);
  }
  return { kind: 'criteria', unpassed, unidentified };
}

function sqlCriteria(issueId: string) {
  return sql`SELECT acceptance_criteria FROM issues WHERE id = ${issueId}`;
}
