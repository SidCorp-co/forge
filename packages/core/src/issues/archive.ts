/**
 * Archiving an issue (ISS-1237): out of every discovery read, still answered by key, reversible.
 *
 * The read side is `issueArchiveSide`, which every read that lists or searches issues composes.
 * Its twin over the memory corpus, where each issue lives again as a `memories` row, is
 * `memory/live-issue.ts:memoryOfLiveIssue`. The memory rows themselves are not archived:
 * `memories.archived_at` is decay's soft delete, followed by a hard purge.
 *
 * The write side is one operation over a filter, in either direction, with a dry run. A row that
 * is not terminal, or that a non-terminal issue still points at, is refused by name and the whole
 * call writes nothing: hiding it would leave live work, or an edge, pointing at a row no reader
 * can see.
 */

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { and, eq, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { type IssueStatus, issueDependencies, issues } from '../db/schema.js';
import { issueRefFormatter } from './issue-prefix-read.js';

/** The condition a discovery read composes: nothing when the caller asked for archived rows too. */
export function issueArchiveSide(includeArchived: boolean | undefined): SQL[] {
  return includeArchived ? [] : [isNull(issues.archivedAt)];
}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The refusal an edge write or a transition gets when it names an archived issue. */
function archivedIssueSentence(key: string, projectId: string): string {
  return `${key} is archived. Unarchive it first — POST /api/projects/${projectId}/issues/unarchive with {"filter":{"keys":["${key}"]}} — then retry`;
}

/**
 * Why a transition may not happen, where an archive stands in its way; `null` where none does.
 * The row itself is locked `FOR UPDATE`. Leaving `closed`/`dropped` is also refused while an
 * unexpired edge ties the row to an archived issue, since that edge would make the archived one
 * load-bearing again; `loadBearingEdges` holds the same counterpart rows `FOR SHARE`, so the two
 * cannot both pass on what each read before the other wrote.
 */
export async function archiveRefusalForTransition(
  tx: Tx,
  issueId: string,
  toStatus: IssueStatus,
): Promise<string | null> {
  const [own] = await archivedAmong(tx, [issueId], 'update');
  if (own) return own.message;
  if (ISSUE_TERMINAL_STATUSES.includes(toStatus)) return null;
  const other = alias(issues, 'archived_side');
  const live = or(
    isNull(issueDependencies.validUntil),
    sql`${issueDependencies.validUntil} > now()`,
  );
  const [tied] = await tx
    .select({ edgeKind: issueDependencies.kind, projectId: other.projectId, issSeq: other.issSeq })
    .from(issueDependencies)
    .innerJoin(
      other,
      or(
        and(eq(issueDependencies.fromIssueId, issueId), eq(other.id, issueDependencies.toIssueId)),
        and(eq(issueDependencies.toIssueId, issueId), eq(other.id, issueDependencies.fromIssueId)),
      ),
    )
    .where(and(live, isNotNull(other.archivedAt)))
    .limit(1);
  if (!tied) return null;
  const key = (await issueRefFormatter(tied.projectId))(tied.issSeq);
  return `this issue cannot become \`${toStatus}\` while a live \`${tied.edgeKind}\` edge ties it to ${key}, which is archived and would be load-bearing again. Retract the edge, or: ${archivedIssueSentence(key, tied.projectId)}`;
}

/**
 * The archived issues among `issueIds`, each with the sentence that refuses a write naming it.
 * `lock` takes the rows `FOR UPDATE` (a transition) or `FOR SHARE` (an edge write), either of which
 * waits on an archive holding them and then reads what it committed. Without it this is a plain
 * read, for a refusal owed before any other check runs.
 */
export async function archivedAmong(
  ex: Pick<Tx, 'select'>,
  issueIds: readonly string[],
  lock?: 'update' | 'share',
): Promise<Array<{ issueId: string; key: string; message: string }>> {
  if (issueIds.length === 0) return [];
  const read = ex
    .select({
      id: issues.id,
      projectId: issues.projectId,
      issSeq: issues.issSeq,
      archivedAt: issues.archivedAt,
    })
    .from(issues)
    .where(inArray(issues.id, [...issueIds]));
  const rows = lock ? await read.for(lock) : await read;
  const archived = rows.filter((r) => r.archivedAt !== null);
  const out: Array<{ issueId: string; key: string; message: string }> = [];
  for (const r of archived) {
    const key = (await issueRefFormatter(r.projectId))(r.issSeq);
    out.push({ issueId: r.id, key, message: archivedIssueSentence(key, r.projectId) });
  }
  return out;
}
