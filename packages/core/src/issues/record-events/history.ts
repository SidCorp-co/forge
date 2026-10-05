// Every record an issue holds, in the order written. A record comment written before events existed
// was given its event by migration 0413, so events are the only read (ISS-56).

import { isKernelOnlyRecordKind, type RecordEventKind } from '@forge/contracts/record-events';
import { db, type Tx } from '../../db/client.js';
import type { ForgeRecord } from '../../messaging/forge-record.js';
import { listRecordEvents, recordOfEvent } from './store.js';

export interface RecordEntry {
  readonly id: string;
  readonly eventId: string;
  readonly commentId: string | null;
  readonly kind: string | null;
  readonly record: ForgeRecord;
  readonly createdAt: Date;
  /** Written on a paired device's credential: a run's write, never a person's. */
  readonly byDevice: boolean;
}

interface RecordHistoryQuery {
  readonly kinds: readonly RecordEventKind[];
  /** Only records written strictly after this moment. */
  readonly after?: Date | null;
}

/** The records of these kinds on one issue, oldest first. */
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
  return events
    .filter((e) => !query.after || e.createdAt.getTime() > query.after.getTime())
    .map(
      (e): RecordEntry => ({
        id: e.id,
        eventId: e.id,
        commentId: e.commentId,
        kind: e.kind,
        record: recordOfEvent(e),
        createdAt: e.createdAt,
        byDevice: e.actorType === 'device',
      }),
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}
