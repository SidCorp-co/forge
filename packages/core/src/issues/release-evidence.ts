// ISS-55 — the evidence `awaiting_release` stands on, read from `criterion_verdicts`, never comments.

import { sql } from 'drizzle-orm';
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
      /** Passing, but recorded at or before the issue's latest reopen: not current evidence. */
      predateReopen: number[];
    };

/**
 * The gate's reading of a set of criteria and their latest verdicts. A verdict recorded at or
 * before `reopenedAt` said the issue was right before a person said it was not, so it is
 * evidence about a build the reopen rejected and never counts as current.
 */
export function evaluateCriteria(
  criteria: readonly CriterionWithVerdict[],
  reopenedAt: Date | null = null,
): CriteriaEvidence {
  if (criteria.length === 0) return { kind: 'no-criteria' };
  const unpassed: Array<{ criterion: number; verdict: string | null }> = [];
  const unidentified: number[] = [];
  const predateReopen: number[] = [];
  for (const { n, latest } of criteria) {
    if (!latest || !PASSING.has(latest.verdict)) {
      unpassed.push({ criterion: n, verdict: latest?.verdict ?? null });
      continue;
    }
    if (reopenedAt && new Date(latest.createdAt).getTime() <= reopenedAt.getTime()) {
      predateReopen.push(n);
      continue;
    }
    if (latest.identityKind === null || latest.identityKind === 'commit_unresolved') {
      unidentified.push(n);
    }
  }
  return { kind: 'criteria', unpassed, unidentified, predateReopen };
}

/**
 * When each issue last entered `reopen`, read from the move history (`kernel_transitions`); an
 * issue never reopened is absent. A verdict at or before that instant is not current evidence:
 * the release gate refuses it (`VERDICT_PREDATES_REOPEN`) and a coverage reader should too.
 */
export async function reopenedAtOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Map<string, Date>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await executor.execute(sql`
    SELECT entity_id, max(created_at) AS at
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND to_status = 'reopen'
       AND entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     GROUP BY entity_id`)) as unknown as Array<{ entity_id: string; at: Date | string }>;
  return new Map([...rows].map((r) => [r.entity_id, new Date(r.at)]));
}

export async function unpassedCriteria(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
): Promise<CriteriaEvidence & { reopenedAt: Date | null }> {
  // Sequential: inside the transition's transaction both reads share one connection.
  const criteria = await listCriteria(executor, issueId);
  const reopened = await reopenedAtOf(executor, [issueId]);
  const reopenedAt = reopened.get(issueId) ?? null;
  return { ...evaluateCriteria(criteria, reopenedAt), reopenedAt };
}
