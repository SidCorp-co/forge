/**
 * Whether a commit a verdict names is the one a shipped release recorded shipping while that release
 * holds the issue's work (ISS-1079, FB-545): then it holds the issue's landing, since the release was
 * cut and shipped carrying that work. Read from Forge's own rows (the release record,
 * `issues/release-evidence.ts:holdingReleaseRunsSql`, and the commit its finish names), never from the
 * host. sidcorp-mail's 0.16.0 shipped ISS-11 at 62a4ac7, a merge into `master` where no landing is
 * marked, so the landing marks alone (`recorded-holding.ts`) could not place a pass judged live there.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { holdingReleaseRunsSql } from '../issues/index.js';

/** One issue and a whole commit one of its verdicts names. */
export interface ShippedAsk {
  issueId: string;
  sha: string;
}

export const shippedAskKey = (a: ShippedAsk) => `${a.issueId.toLowerCase()}:${a.sha.toLowerCase()}`;

/** Per ask (`shippedAskKey`) a shipped release holding the issue recorded shipping at, its version. */
export async function shippedReleaseHolding(
  projectId: string,
  asks: readonly ShippedAsk[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (asks.length === 0) return out;
  const values = sql.join(
    asks.map((a) => sql`(${a.issueId.toLowerCase()}, ${a.sha.toLowerCase()})`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT a.issue_id, a.sha, r.release_version AS version
      FROM (VALUES ${values}) AS a(issue_id, sha)
      JOIN pipeline_runs r
        ON r.project_id = ${projectId}
       AND r.metadata ->> 'source' = 'release-batch'
       AND r.metadata -> 'finish' ->> 'state' = 'finished'
       AND lower(r.metadata -> 'finish' ->> 'commit') = a.sha
     WHERE EXISTS (SELECT 1 FROM (${holdingReleaseRunsSql(sql`a.issue_id`, sql`${projectId}`)}) h
                    WHERE h.id = r.id)
  `)) as unknown as Array<{ issue_id: string; sha: string; version: string }>;
  for (const r of rows) out.set(shippedAskKey({ issueId: r.issue_id, sha: r.sha }), r.version);
  return out;
}
