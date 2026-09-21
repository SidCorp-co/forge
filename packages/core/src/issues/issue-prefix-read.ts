import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { issuePrefixAliases, projects } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';

export { canonicalIssueKey } from '../lib/issue-ref.js';

export type IssueRefReader = Pick<typeof defaultDb, 'select'>;

/** The active prefix, for building a reference. NULL where the project renders the legacy one. */
export async function activeIssuePrefix(
  projectId: string,
  dbi: IssueRefReader = defaultDb,
): Promise<string | null> {
  const [row] = await dbi
    .select({ issuePrefix: projects.issuePrefix })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.issuePrefix ?? null;
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
