import { eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';

/** `ISS-nn` for each of these in one read, on the caller's transaction where it has one; the uuid
 *  keying them is on no screen. */
export async function issueDisplayIds(
  issueIds: string[],
  executor: Tx = db,
): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const rows = await executor
    .select({ id: issues.id, issSeq: issues.issSeq, issuePrefix: projects.issuePrefix })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(inArray(issues.id, issueIds));
  return new Map(rows.map((r) => [r.id, formatIssueRef(r.issuePrefix, r.issSeq)]));
}
