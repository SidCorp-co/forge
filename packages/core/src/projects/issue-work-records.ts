import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import type { IssueWorkRecord } from './commit-owners.js';

const worklog = (key: 'head' | 'base' | 'branch') =>
  sql<string | null>`${issues.sessionContext}->'worklog'->>${key}`;

/**
 * The project's issues whose recorded merged commit or recorded work head is one of `shas`, which
 * are compared in lower case. The worklog is what `forge claim --pushed` writes, and the same field
 * `pipeline/work-evidence.ts` reads an issue's branch from.
 */
export async function issueWorkRecordsAt(
  projectId: string,
  shas: readonly string[],
): Promise<IssueWorkRecord[]> {
  if (shas.length === 0) return [];
  const wanted = [...new Set(shas.map((s) => s.toLowerCase()))];
  return db
    .select({
      issSeq: issues.issSeq,
      mergedCommitSha: issues.mergedCommitSha,
      head: worklog('head'),
      base: worklog('base'),
      branch: worklog('branch'),
    })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        or(
          inArray(sql`lower(${issues.mergedCommitSha})`, wanted),
          inArray(sql`lower(${worklog('head')})`, wanted),
        ),
      ),
    );
}
