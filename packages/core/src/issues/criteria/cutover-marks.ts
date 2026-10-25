// Which latest verdicts on an issue's criteria count only under the builder-pass cutover (contracts
// `verified-rule.ts:BUILDER_PASS_CUTOVER`): a pass the building run recorded before it, on a project
// whose `qa` is not independent. The criteria read marks each, so a judge sees whose pass it is.

import { countedUnderCutover } from '@forge/contracts/verified-rule';
import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { verdictByBuilderSql } from '../built-by.js';
import { readJudge } from '../ports.js';

/** The ids, among `verdicts`, of the passes counted only under the cutover. */
export async function underCutoverOf(
  executor: Pick<Tx, 'execute'>,
  projectId: string,
  verdicts: readonly { id: string; verdict: string }[],
): Promise<Set<string>> {
  const passes = verdicts.filter((v) => v.verdict === 'pass').map((v) => v.id);
  if (passes.length === 0) return new Set();
  const rows = (await executor.execute(sql`
    SELECT v.id, v.created_at AS recorded_at, ${verdictByBuilderSql({
      issueId: sql`v.issue_id`,
      authorUser: sql`v.author_user_id`,
      authorDevice: sql`v.author_device_id`,
      at: sql`v.created_at`,
      runSession: sql`v.run_session_id`,
    })} AS by_builder
      FROM criterion_verdicts v
     WHERE v.id IN (${sql.join(
       passes.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})`)) as unknown as {
    id: string;
    recorded_at: string | Date;
    by_builder: boolean | null;
  }[];
  const judge = await readJudge(projectId);
  return new Set(
    rows
      .filter((r) =>
        countedUnderCutover(
          {
            verdict: 'pass',
            byBuilder: r.by_builder === true,
            authored: true,
            recordedAt: r.recorded_at,
          },
          judge,
        ),
      )
      .map((r) => r.id),
  );
}
