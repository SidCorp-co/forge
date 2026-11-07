import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memoizedRead } from '../db/read-memo.js';
import { issues } from '../db/schema.js';
import { waitingForReleaseSql } from '../issues/index.js';

/**
 * Every issue waiting unclaimed for a release on this project (`waitingForReleaseSql`: at the gate, or
 * closed met in scope with no shipped release holding it), oldest merge first: the roster a cut, the
 * draft and the sweep read. An issue a release run still claims after it ended is in none of
 * them; `ended-claims.ts:readEndedRunHolds` is the read that names it, beside each of these (ISS-961).
 */
export async function waitingIssueIds(projectId: string): Promise<string[]> {
  // the draft, each requirement's release leg and the release facts each ask it in one read
  return memoizedRead(`waitingIssueIds:${projectId}`, async () => {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.projectId, projectId),
          waitingForReleaseSql(sql`${issues}`),
          isNull(issues.releaseBatchRunId),
        ),
      )
      .orderBy(sql`${issues.mergedAt} ASC NULLS LAST`, asc(issues.id));
    return rows.map((r) => r.id);
  });
}
