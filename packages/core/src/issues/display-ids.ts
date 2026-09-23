import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';

/** `ISS-nn` for each of these in one read; the uuid keying them is on no screen. */
export async function issueDisplayIds(issueIds: string[]): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .select({ id: issues.id, issSeq: issues.issSeq, issuePrefix: projects.issuePrefix })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(inArray(issues.id, issueIds));
  return new Map(rows.map((r) => [r.id, formatIssueRef(r.issuePrefix, r.issSeq)]));
}
