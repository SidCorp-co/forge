// How each verdict counts toward its criterion, as the verified rule reads it (contracts
// `verified-rule.ts`): a pass or short the building run recorded is kept as its evidence and never
// counts (`notCountedOf`, REQ-74 BC-2), save one recorded before `BUILDER_PASS_CUTOVER` on a project
// whose `qa` is not independent, which counts only under that amnesty (`countedUnderCutover`). The
// verdict write and the criteria read both answer it from here, so a reader is told the same thing
// the writer was, and the read checks every row it shows in one query.

import { countedUnderCutover, type NotCounted, notCountedOf } from '@forge/contracts/verified-rule';
import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import {
  builderCandidatesAcrossSql,
  declaredBeforeLandingSql,
  verdictByBuilderSql,
} from '../built-by.js';
import { readJudge } from '../ports.js';

/** How one verdict counts: named where it never will, marked where it counts only by the amnesty. */
export interface VerdictCounting {
  notCounted: NotCounted | null;
  countedUnderCutover: boolean;
}

const COUNTS: VerdictCounting = { notCounted: null, countedUnderCutover: false };

/**
 * How each of `verdicts` counts, by id, read through the same builder rule every count of proof
 * reads (`built-by.ts`), in one query whatever their number: the criteria read and the issue
 * standing ask it over a whole page. A fail or a skip counts whoever records it, so only passes and
 * shorts are read; one id absent from the answer counts as it is.
 */
export async function countingOf(
  executor: Pick<Tx, 'execute'>,
  projectId: string,
  verdicts: readonly { id: string; verdict: string }[],
): Promise<Map<string, VerdictCounting>> {
  const judged = verdicts.filter((v) => v.verdict === 'pass' || v.verdict === 'short');
  if (judged.length === 0) return new Map();
  const ids = sql.join(
    judged.map((v) => sql`${v.id}::uuid`),
    sql`, `,
  );
  // every issue's builder candidates read once for the statement, not once per verdict
  const issues = sql`(SELECT DISTINCT iv.issue_id FROM criterion_verdicts iv WHERE iv.id IN (${ids}))`;
  const rows = (await executor.execute(sql`
    SELECT v.id, v.verdict, v.created_at AS recorded_at, ${verdictByBuilderSql({
      issueId: sql`v.issue_id`,
      authorUser: sql`v.author_user_id`,
      authorDevice: sql`v.author_device_id`,
      at: sql`v.created_at`,
      runSession: sql`v.run_session_id`,
      candidates: sql`bc.candidates`,
    })} AS by_builder,
      CASE WHEN v.run_session_id IS NULL THEN NULL
           ELSE ${declaredBeforeLandingSql(sql`v.issue_id`, sql`v.run_session_id`)} END AS opened_at
      FROM criterion_verdicts v
     CROSS JOIN (SELECT ${builderCandidatesAcrossSql(issues)} AS candidates) bc
     WHERE v.id IN (${ids})`)) as unknown as {
    id: string;
    verdict: string;
    recorded_at: string | Date;
    by_builder: boolean | null;
    opened_at: string | null;
  }[];
  const judge = await readJudge(projectId);
  return new Map(
    rows.map((r) => {
      const read = {
        verdict: r.verdict,
        byBuilder: r.by_builder === true,
        authored: true,
        recordedAt: r.recorded_at,
      };
      return [
        r.id,
        {
          notCounted: notCountedOf(read, judge, r.opened_at),
          countedUnderCutover: countedUnderCutover(read, judge),
        },
      ];
    }),
  );
}

/** How the one verdict `id` counts (`countingOf`). */
export async function countingOfOne(
  executor: Pick<Tx, 'execute'>,
  projectId: string,
  verdict: { id: string; verdict: string },
): Promise<VerdictCounting> {
  return (await countingOf(executor, projectId, [verdict])).get(verdict.id) ?? COUNTS;
}
