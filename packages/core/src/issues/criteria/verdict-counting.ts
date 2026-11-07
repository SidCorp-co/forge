// How each verdict counts toward its criterion, as the verified rule reads it (contracts
// `verified-rule.ts`): a pass or short the building run recorded is kept as its evidence and never
// counts (`notCountedOf`, REQ-74 BC-2), save one recorded before `BUILDER_PASS_CUTOVER` on a project
// whose `qa` is not independent, which counts only under that amnesty (`countedUnderCutover`). The
// verdict write and the criteria read both answer it from here, so a reader is told the same thing
// the writer was, and the read checks every row it shows in one query.

import { countedUnderCutover, type NotCounted, notCountedOf } from '@forge/contracts/verified-rule';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { rowsPerId } from '../../db/read-memo.js';
import {
  builderFactColumnsSql,
  builderFactJoinSql,
  readWithBuilderFacts,
} from '../builder-facts.js';
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
  // a verdict's builder facts are its own: every project's asks are one read (ISS-1070 r6)
  const ids = judged.map((v) => v.id);
  const rows =
    executor === db
      ? await rowsPerId(
          'verdictCounting',
          ids,
          (some) => countingRows(db, some),
          (r) => r.id,
        )
      : await countingRows(executor, ids);
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
          notCounted: notCountedOf(read, judge, r.fact_declared),
          countedUnderCutover: countedUnderCutover(read, judge),
        },
      ];
    }),
  );
}

async function countingRows(executor: Pick<Tx, 'execute'>, verdictIds: readonly string[]) {
  const ids = sql.join(
    verdictIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  // the builder rule is read from the model each write keeps (`builder-facts.ts`), never computed here
  return readWithBuilderFacts(
    executor,
    async () =>
      (await executor.execute(sql`
    SELECT v.id, v.issue_id, v.verdict, v.created_at AS recorded_at,
           ${builderFactColumnsSql(sql`v.issue_id`)}
      FROM criterion_verdicts v
      ${builderFactJoinSql(sql`v.id`)}
     WHERE v.id IN (${ids})`)) as unknown as {
        id: string;
        issue_id: string;
        verdict: string;
        recorded_at: string | Date;
        by_builder: boolean | null;
        fact_declared: string | null;
        fact_owed: boolean;
        fact_missing: boolean;
      }[],
    (r) => (r.fact_owed ? { issueId: r.issue_id, missing: r.fact_missing } : null),
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
