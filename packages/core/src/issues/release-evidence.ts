// ISS-55 — the evidence `awaiting_release` stands on, read from `criterion_verdicts`, never comments.

import type { Tx } from '../db/client.js';
import { type CriterionWithVerdict, listCriteria } from './criteria/store.js';

const PASSING: ReadonlySet<string> = new Set(['pass', 'short']);

export type CriteriaEvidence =
  | { kind: 'no-criteria' }
  | {
      kind: 'criteria';
      unpassed: Array<{ criterion: number; verdict: string | null }>;
      /** Passing, with no identity the gate accepts; a backfilled `commit_unresolved` is none. */
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
