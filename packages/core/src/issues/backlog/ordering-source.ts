/**
 * The ranking inputs for a whole backlog, one item at a time (ISS-1173).
 *
 * This streams what a ranking READS and never a ranking. `forge next`'s weight table lives in the
 * CLI, where a project overrides one weight at a time in a settings file this server cannot see; a
 * server that ranked here would drop those overrides without saying so.
 *
 * Paging is keyset on `(createdAt, id)` rather than offset, because the stream outlives any single
 * snapshot: an offset page over a table somebody is writing to skips and repeats rows.
 */

import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { type IssueStatus, issues } from '../../db/schema.js';
import { loadIssueRelationsForIssues } from '../dependency-read.js';
import { issueRefFormatter } from '../issue-prefix-read.js';
import type { Cancellation } from './cancellation.js';
import type { BacklogSource, SourceDone } from './emitter.js';

/** Rows read per database round trip. One relations query is spent per page, whatever its size. */
export const ORDERING_PAGE_SIZE = 100;

export interface OrderingInput {
  projectId: string;
  statuses: IssueStatus[];
  withBody: boolean;
  cancellation: Cancellation;
}

type Cursor = { createdAt: Date; id: string } | null;

const baseColumns = {
  id: issues.id,
  issSeq: issues.issSeq,
  title: issues.title,
  status: issues.status,
  waitingKind: issues.waitingKind,
  priority: issues.priority,
  category: issues.category,
  complexity: issues.complexity,
  assigneeId: issues.assigneeId,
  reopenCount: issues.reopenCount,
  mergedAt: issues.mergedAt,
  mergedCommitSha: issues.mergedCommitSha,
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
} as const;

const bodyColumns = {
  description: issues.description,
  plan: issues.plan,
  acceptanceCriteria: issues.acceptanceCriteria,
} as const;

function matching(projectId: string, statuses: IssueStatus[]) {
  return and(eq(issues.projectId, projectId), inArray(issues.status, statuses));
}

/** Counted once, before the first item, so a reader has a denominator for progress. */
export async function countMatching(projectId: string, statuses: IssueStatus[]): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .where(matching(projectId, statuses));
  return row?.n ?? 0;
}

async function readPage(input: OrderingInput, after: Cursor) {
  const columns = input.withBody ? { ...baseColumns, ...bodyColumns } : baseColumns;
  const keyset = after
    ? and(
        matching(input.projectId, input.statuses),
        or(
          gt(issues.createdAt, after.createdAt),
          and(eq(issues.createdAt, after.createdAt), gt(issues.id, after.id)),
        ),
      )
    : matching(input.projectId, input.statuses);
  return db
    .select(columns)
    .from(issues)
    .where(keyset)
    .orderBy(asc(issues.createdAt), asc(issues.id))
    .limit(ORDERING_PAGE_SIZE);
}

/**
 * Yields one item per matching issue. Cancellation is checked before each page is read, so a
 * caller that has gone stops costing database work rather than being served to the end.
 */
export async function* orderingSource(input: OrderingInput): BacklogSource<unknown> {
  const displayIdOf = await issueRefFormatter(input.projectId);
  let cursor: Cursor = null;

  for (;;) {
    if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;
    const page = await readPage(input, cursor);
    if (page.length === 0) return { exhausted: true } satisfies SourceDone;

    const relations = await loadIssueRelationsForIssues(
      page.map((row) => row.id),
      input.projectId,
    );
    for (const row of page) {
      yield {
        ...row,
        displayId: displayIdOf(row.issSeq),
        relations: relations.get(row.id) ?? { blocks: [], blockedBy: [] },
      };
    }

    const last = page[page.length - 1];
    if (!last) return { exhausted: true } satisfies SourceDone;
    if (page.length < ORDERING_PAGE_SIZE) return { exhausted: true } satisfies SourceDone;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
}
