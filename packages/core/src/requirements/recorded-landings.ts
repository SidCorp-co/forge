/**
 * The landings Forge recorded itself on a project, as a verdict recorded at a requirement is weighed
 * on a project with no production environment (`standing-identity.ts:atRecordedLanding`): an
 * issue's merge mark (`issues.merged_commit_sha`, its time and target branch) is Forge's own record
 * of a build reaching the branch its environment deploys. Read from the record, never from a host's
 * ancestry (owner: agents record, Forge never infers).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { canonicalIssueKey } from '../lib/issue-ref.js';
import type { RecordedLanding, RecordedLandings } from './standing-identity.js';

interface Row {
  id: string;
  iss_seq: number;
  sha: string | null;
  at: Date | string | null;
  target: string | null;
}

/** Each commit in `commits` that an issue's merge mark names, and each of `issueIds`' own landing. */
export async function recordedLandingsOf(
  projectId: string,
  commits: readonly string[],
  issueIds: readonly string[],
): Promise<RecordedLandings> {
  const shas = [...new Set(commits.map((c) => c.toLowerCase()))];
  const ids = [...new Set(issueIds.map((i) => i.toLowerCase()))];
  const named = new Map<string, RecordedLanding>();
  const issues = new Map<string, RecordedLanding | null>(ids.map((id) => [id, null]));
  if (shas.length === 0 && ids.length === 0) return { named, issues };
  const list = (xs: readonly string[]) =>
    xs.length === 0
      ? sql`NULL`
      : sql.join(
          xs.map((x) => sql`${x}`),
          sql`, `,
        );
  const rows = (await db.execute(sql`
    SELECT id, iss_seq, merged_commit_sha AS sha, merged_at AS at, merged_target AS target
      FROM issues
     WHERE project_id = ${projectId}
       AND (id::text IN (${list(ids)}) OR lower(merged_commit_sha) IN (${list(shas)}))
  `)) as unknown as Row[];
  for (const r of rows) {
    const landing: RecordedLanding | null =
      r.sha && r.at
        ? {
            issueKey: canonicalIssueKey(r.iss_seq),
            sha: r.sha.toLowerCase(),
            at: new Date(r.at),
            target: r.target,
          }
        : null;
    if (issues.has(r.id.toLowerCase())) issues.set(r.id.toLowerCase(), landing);
    if (!landing || !shas.includes(landing.sha)) continue;
    const before = named.get(landing.sha);
    if (!before || before.at < landing.at) named.set(landing.sha, landing);
  }
  return { named, issues };
}
