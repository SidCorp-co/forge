// Every record an issue holds, in the order written: its typed events, and the records that were
// only ever posted as comment fences before events existed (ISS-56).

import { and, asc, eq, gt, like } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { comments } from '../../db/schema.js';
import { type ForgeRecord, parseForgeRecord } from '../../messaging/forge-record.js';
import { isKernelOnlyRecordKind, type RecordEventKind } from '@forge/contracts/record-events';
import { listRecordEvents, mirroredCommentIds, recordOfEvent } from './store.js';

export interface RecordEntry {
  /** The event's id, or the comment's where the record was never an event. */
  readonly id: string;
  readonly source: 'event' | 'comment';
  readonly eventId: string | null;
  readonly commentId: string | null;
  readonly kind: string | null;
  readonly record: ForgeRecord;
  readonly createdAt: Date;
  /** Written on a paired device's credential: a run's write, never a person's. */
  readonly byDevice: boolean;
}

export interface RecordHistoryQuery {
  readonly kinds: readonly RecordEventKind[];
  /** Only records written strictly after this moment. */
  readonly after?: Date | null;
}

/**
 * cm:hack — a record comment with no event of its own is read for history, and one mirrored into an
 * event is skipped, so no record is read twice. Ends when a backfill gives every such comment its
 * event; then events are the only read.
 */
async function legacyCommentRecords(
  issueId: string,
  query: RecordHistoryQuery,
  executor: Tx,
): Promise<RecordEntry[]> {
  const mirrored = await mirroredCommentIds(issueId, executor);
  const scope = [eq(comments.issueId, issueId), like(comments.body, '%forge-record%')];
  if (query.after) scope.push(gt(comments.createdAt, query.after));
  const rows = await executor
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      device: comments.authorDeviceId,
    })
    .from(comments)
    .where(and(...scope))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  const wanted = new Set<string>(query.kinds.filter((kind) => !isKernelOnlyRecordKind(kind)));
  return rows.flatMap((row): RecordEntry[] => {
    if (mirrored.has(row.id)) return [];
    const record = parseForgeRecord(row.body);
    if (!record?.kind || !wanted.has(record.kind)) return [];
    return [
      {
        id: row.id,
        source: 'comment',
        eventId: null,
        commentId: row.id,
        kind: record.kind,
        record,
        createdAt: row.createdAt,
        byDevice: row.device !== null,
      },
    ];
  });
}

/** The records of these kinds on one issue, oldest first, events and legacy comments merged. */
export async function recordHistory(
  issueId: string,
  query: RecordHistoryQuery,
  executor: Tx = db,
): Promise<RecordEntry[]> {
  // cm:guard ISS-96 — a transition, park or verdict is read only as core wrote it, never from a
  // comment fence or an event a caller posted
  const kernel = query.kinds.filter((kind) => isKernelOnlyRecordKind(kind));
  const told = query.kinds.filter((kind) => !isKernelOnlyRecordKind(kind));
  const events = [
    ...(kernel.length > 0
      ? await listRecordEvents(issueId, { kinds: kernel, kernelOnly: true }, executor)
      : []),
    ...(told.length > 0 ? await listRecordEvents(issueId, { kinds: told }, executor) : []),
  ];
  const fromEvents = events
    .filter((e) => !query.after || e.createdAt.getTime() > query.after.getTime())
    .map(
      (e): RecordEntry => ({
        id: e.id,
        source: 'event',
        eventId: e.id,
        commentId: e.commentId,
        kind: e.kind,
        record: recordOfEvent(e),
        createdAt: e.createdAt,
        byDevice: e.actorType === 'device',
      }),
    );
  const legacy = await legacyCommentRecords(issueId, query, executor);
  return [...fromEvents, ...legacy].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}
