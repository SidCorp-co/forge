/**
 * A merge never stamps another issue that is already over (ISS-1027, adminhub-api FB-528).
 *
 * A change request's links are read from its branch, title and body (`head-ref-link.ts`). MR 5162's
 * branch `fix/strict-check-recursive-not-iss-50-2` was read as naming ISS-50 and ISS-2, and its merge
 * stamped ISS-2, closed long before and unrelated, over the landing its release had shipped. The
 * branch now names its one key, but a title or body can still name a shipped issue in passing. An
 * issue that is closed or dropped takes no landing from another issue's merge: it is not written to,
 * and the merge answers it as skipped with its status and the reading that named it. The issue the
 * merge was called on is the caller's own and keeps the route's own rules.
 */

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import type { ChangeRequestReading } from '../db/schema-repo-projection.js';
import { logger } from '../lib/logger.js';
import { issueRefFormatter } from './issue-prefix-read.js';

const READING_WORDS: Record<ChangeRequestReading, string> = {
  'branch-lead': "the key leading the request's branch",
  'branch-tail': "the numbers the request's branch ends with",
  title: "the request's title",
  body: "the request's description",
};

/**
 * Why the merge leaves this linked issue untouched, or null where it is stamped as before: an issue
 * other than `callIssueId` whose status is terminal (`ISSUE_TERMINAL_STATUSES`).
 */
export async function overIssueStampSkip(
  tx: Tx,
  args: { issueId: string; callIssueId: string; namedBy: ChangeRequestReading },
): Promise<{ status: string; detail: string } | null> {
  if (args.issueId === args.callIssueId) return null;
  const [row] = await tx
    .select({ projectId: issues.projectId, issSeq: issues.issSeq, status: issues.status })
    .from(issues)
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (!row || !(ISSUE_TERMINAL_STATUSES as readonly string[]).includes(row.status)) return null;
  const key = (await issueRefFormatter(row.projectId, tx))(row.issSeq);
  logger.warn(
    { issueId: args.issueId, status: row.status, namedBy: args.namedBy },
    'merge stamp skipped: the linked issue is already over',
  );
  return {
    status: row.status,
    detail:
      `${key} is ${row.status}, so this merge did not stamp it: ${READING_WORDS[args.namedBy]} ` +
      `named it, and an issue that is over takes no landing from another issue's merge. If this ` +
      `commit is ${key}'s work, reopen it and mark the commit on it (POST /api/issues/:id/merge).`,
  };
}
