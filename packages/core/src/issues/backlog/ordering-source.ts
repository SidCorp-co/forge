/**
 * The ranking inputs for a whole backlog, one item at a time (ISS-1173).
 *
 * This streams what a ranking READS and never a ranking. `forge next`'s weight table lives in the
 * CLI, where a project overrides one weight at a time in a settings file this server cannot see; a
 * server that ranked here would drop those overrides without saying so.
 *
 * Paging is keyset rather than offset, because the stream outlives any single snapshot: an offset
 * page over a table somebody is writing to skips and repeats rows. The boundary is `page-read.ts`.
 */

import type { IssueStatus } from '../../db/schema.js';
import { issues } from '../../db/schema.js';
import { loadIssueRelationsForIssues } from '../dependency-read.js';
import { issueRefFormatter } from '../issue-prefix-read.js';
import type { Cancellation } from './cancellation.js';
import type { BacklogSource, SourceDone } from './emitter.js';
import { issuePage, type PageCursor } from './page-read.js';

/** Rows read per database round trip. One relations query is spent per page, whatever its size. */
export const ORDERING_PAGE_SIZE = 100;

export interface OrderingInput {
  projectId: string;
  statuses: IssueStatus[];
  withBody: boolean;
  cancellation: Cancellation;
}

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

/** Each row split into the fields an item carries and the paging state, which never reaches the wire. */
async function readPage(input: OrderingInput, after: PageCursor | null) {
  const rows = await issuePage({
    columns: input.withBody ? { ...baseColumns, ...bodyColumns } : baseColumns,
    projectId: input.projectId,
    statuses: input.statuses,
    after,
    limit: ORDERING_PAGE_SIZE,
  });
  return rows.map((row) => {
    const { cursorAt, ...fields } = row;
    return { fields, cursor: { cursorAt, id: row.id } satisfies PageCursor };
  });
}

/**
 * Yields one item per matching issue. Cancellation is checked before each page is read, so a
 * caller that has gone stops costing database work rather than being served to the end.
 */
export async function* orderingSource(input: OrderingInput): BacklogSource<unknown> {
  if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;
  const displayIdOf = await issueRefFormatter(input.projectId);
  let cursor: PageCursor | null = null;

  for (;;) {
    if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;
    const page = await readPage(input, cursor);
    if (page.length === 0) return { exhausted: true } satisfies SourceDone;
    if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;

    const relations = await loadIssueRelationsForIssues(
      page.map((row) => row.fields.id),
      input.projectId,
    );
    for (const { fields } of page) {
      yield {
        ...fields,
        displayId: displayIdOf(fields.issSeq),
        relations: relations.get(fields.id) ?? { blocks: [], blockedBy: [] },
      };
    }

    const last = page[page.length - 1];
    if (!last) return { exhausted: true } satisfies SourceDone;
    if (page.length < ORDERING_PAGE_SIZE) return { exhausted: true } satisfies SourceDone;
    cursor = last.cursor;
  }
}
