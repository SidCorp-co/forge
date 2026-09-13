/** Lets the chat model address an issue by the short id `forge_issues` prints beside the UUID — measured 2026-09-04 on two models, both failed `get` for ISS-3 because `documentId` is `z.uuid()`; rewritten inside the bound project before the handler parses. */

import { and, eq } from 'drizzle-orm';
import type { db as defaultDb } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { issueRefPrefixOf, parseIssueRef } from '../../lib/issue-ref.js';

export type IssueLookupDb = Pick<typeof defaultDb, 'select'>;

export async function resolveIssueDisplayId(
  dbi: IssueLookupDb,
  projectId: string,
  args: Record<string, unknown>,
  /** Every prefix this project holds; the legacy one is admitted without being listed. */
  prefixes: readonly string[] = [],
): Promise<string | null> {
  const raw = args.documentId;
  if (typeof raw !== 'string') return null;
  if (!issueRefPrefixOf(raw)) return null;
  // cm:guard a prefix this project does not hold is REFUSED by name and never resolved to this project's issue of that number — `FP-977` typed at a forge-dev chat is a different issue somewhere else, and answering with forge-dev's 977 is the confusion ISS-992 exists to end
  const parsed = parseIssueRef(raw, prefixes);
  if (!parsed.ok) return parsed.message;
  const [row] = await dbi
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, parsed.issSeq)))
    .limit(1);
  if (!row) return `no issue ${raw.trim().toUpperCase()} in this project`;
  args.documentId = row.id;
  return null;
}
