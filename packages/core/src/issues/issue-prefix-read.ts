import { eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { memoizedPerId, perProjectRead } from '../db/read-memo.js';
import { issuePrefixAliases, projects } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';

export { canonicalIssueKey } from '../lib/issue-ref.js';

export type IssueRefReader = Pick<typeof defaultDb, 'select'>;

/** The active prefix, for building a reference. NULL where the project renders the legacy one. */
export async function activeIssuePrefix(
  projectId: string,
  dbi: IssueRefReader = defaultDb,
): Promise<string | null> {
  if (dbi !== defaultDb) {
    const [row] = await dbi
      .select({ issuePrefix: projects.issuePrefix })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return row?.issuePrefix ?? null;
  }
  // once a read, and in a read across projects once for all of them (`db/read-memo.ts:perProjectRead`)
  return perProjectRead(
    'issuePrefix',
    projectId,
    (ids) =>
      defaultDb
        .select({ id: projects.id, issuePrefix: projects.issuePrefix })
        .from(projects)
        .where(inArray(projects.id, [...ids])),
    (r) => r.id,
    (rows) => rows[0]?.issuePrefix ?? null,
  );
}

/**
 * The active prefix of each of these projects, in one statement for every project a read asks
 * before its quiet point (`db/read-memo.ts:memoizedPerId`): a list naming issues of many projects
 * (Forge's own feedback, ISS-1070 r12) asked one project's prefix at a time, one statement each.
 */
export async function activeIssuePrefixes(
  projectIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (projectIds.length === 0) return new Map();
  return memoizedPerId('issuePrefixById', projectIds, async (ids) => {
    const rows = await defaultDb
      .select({ id: projects.id, issuePrefix: projects.issuePrefix })
      .from(projects)
      .where(inArray(projects.id, [...ids]));
    return new Map(rows.map((r) => [r.id, r.issuePrefix]));
  });
}

/** Every prefix this project has ever held, for parsing a reference somebody published earlier. */
export async function heldIssuePrefixes(
  projectId: string,
  dbi: IssueRefReader = defaultDb,
): Promise<string[]> {
  const rows = await dbi
    .select({ prefix: issuePrefixAliases.prefix })
    .from(issuePrefixAliases)
    .where(eq(issuePrefixAliases.projectId, projectId));
  return rows.map((r) => r.prefix);
}

/**
 * Every issue prefix any Forge project holds or held, a tombstone's included: a reference somebody
 * published under one still reads as an issue key (ISS-1107, `messaging/internal-codes.ts`).
 */
export async function everyIssuePrefix(dbi: IssueRefReader = defaultDb): Promise<string[]> {
  const rows = await dbi.select({ prefix: issuePrefixAliases.prefix }).from(issuePrefixAliases);
  return rows.map((r) => r.prefix);
}

/** Formats every reference in one operation off a single read, so a map over rows spends one
 *  query and not one per row. */
export async function issueRefFormatter(
  projectId: string,
  dbi: IssueRefReader = defaultDb,
): Promise<(issSeq: number) => string> {
  const prefix = await activeIssuePrefix(projectId, dbi);
  return (issSeq: number) => formatIssueRef(prefix, issSeq);
}

/** The holder of a prefix, or null where nobody holds it. A row whose `projectId` is NULL is a
 *  tombstone: the project that held it is gone and the prefix stays spent. */
export async function issuePrefixHolder(
  prefix: string,
  dbi: IssueRefReader = defaultDb,
): Promise<{ projectId: string | null } | null> {
  const [row] = await dbi
    .select({ projectId: issuePrefixAliases.projectId })
    .from(issuePrefixAliases)
    .where(eq(issuePrefixAliases.prefix, prefix.toUpperCase()))
    .limit(1);
  return row ?? null;
}
