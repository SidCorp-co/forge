// ISS-55 — every criterion's latest verdict, the evidence `awaiting_release` stands on, read from
// `issue_criteria` and `criterion_verdicts` (`criteria/store.ts`). No comment is parsed here: a
// verdict posted as a comment fence reaches this table on the comment's own write
// (`criteria/comment-verdicts.ts`). `transition-guards.ts:verdictGuard` reads this answer's shape.

import type { Tx } from '../db/client.js';
import { type CriterionWithVerdict, listCriteria } from './criteria/store.js';

/** As the release gate counts them (`criteria-verdicts.ts:EARNED_VERDICTS`); `skipped` never. */
const PASSING: ReadonlySet<string> = new Set(['pass', 'short']);

export type CriteriaEvidence =
  | { kind: 'no-criteria' }
  | {
      kind: 'criteria';
      unpassed: Array<{ criterion: number; verdict: string | null }>;
      /**
       * Passing criteria whose latest verdict names no identity the gate accepts. A backfilled
       * `commit_unresolved` is one: its amnesty covers the closed issue it was read from, and a
       * reopened issue earns a new verdict with a whole sha before it is released again.
       */
      unidentified: number[];
    };

/** The gate's reading of a set of criteria and their latest verdicts. */
export function evaluateCriteria(criteria: readonly CriterionWithVerdict[]): CriteriaEvidence {
  if (criteria.length === 0) return { kind: 'no-criteria' };
  const unpassed: Array<{ criterion: number; verdict: string | null }> = [];
  const unidentified: number[] = [];
  for (const { n, latest } of criteria) {
    if (!latest || !PASSING.has(latest.verdict)) {
      unpassed.push({ criterion: n, verdict: latest?.verdict ?? null });
      continue;
    }
    if (latest.identityKind === null || latest.identityKind === 'commit_unresolved') {
      unidentified.push(n);
    }
  }
  return { kind: 'criteria', unpassed, unidentified };
}

export async function unpassedCriteria(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
): Promise<CriteriaEvidence> {
  return evaluateCriteria(await listCriteria(executor, issueId));
}
