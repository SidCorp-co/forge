// cm:hack — the comment-to-event dual path (ISS-56). The pinned forge-plugin still POSTs every
// record as a ```forge-record comment fence, so a comment carrying one is also written as the
// typed event the readers now read, in the comment's own transaction. Ends when forge-plugin writes
// records to `POST /api/issues/:id/events` (logged in forge-local-docs/plugin-followups.md); then a
// fence in a comment is refused `FORGE_RECORD_IN_COMMENT` and this file goes.

import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { activityLog } from '../../db/schema-activity.js';
import { parseForgeRecord } from '../../messaging/forge-record.js';
import type { Actor } from '../../pipeline/activity.js';
import { recordEventVerdicts } from '../criteria/event-verdicts.js';
import { isKernelOnlyRecordKind, isRecordEventKind } from '@forge/contracts/record-events';
import { commentMirrorKey, writeRecordEvent } from './store.js';

export interface MirroredComment {
  readonly id: string;
  readonly issueId: string;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * Write the event a comment's record stands for, or return the warning owed where it is stored as
 * prose only: no kind, a kind outside the set, a kind core writes, or a verdict fence naming none.
 */
export async function mirrorCommentRecord(
  comment: MirroredComment,
  actor: Actor,
  tx: Tx,
): Promise<string[]> {
  const record = parseForgeRecord(comment.body);
  if (!record) return [];
  if (!isRecordEventKind(record.kind)) {
    const named = record.kind ? `kind \`${record.kind}\`` : 'no kind';
    return [
      `RECORD_NOT_TYPED: this comment's \`forge-record\` carries ${named}, so no record event was written for it and no gate will read it — name a record kind on the fence (\`forge-record: <kind> · contract <n>\`), or write it to \`POST /api/issues/:id/events\``,
    ];
  }
  if (record.kind === 'verdict') {
    const written = await recordEventVerdicts(tx, {
      issueId: comment.issueId,
      record,
      actor,
      commentId: comment.id,
    });
    if (written > 0) return [];
    return [
      "VERDICT_RECORD_EMPTY: this comment's `forge-record: verdict` names no criterion with a verdict, so no verdict was recorded and no gate will read one — write `criterion: <n>` and `verdict: pass | short | fail | skipped` in each block, or record it with `POST /api/issues/:id/verdicts`",
    ];
  }
  if (isKernelOnlyRecordKind(record.kind)) {
    return [
      `EVENT_KIND_KERNEL_ONLY: this comment's \`forge-record: ${record.kind}\` is stored as prose only — a ${record.kind} record is kernel evidence core writes in the transaction of the move itself, so no comment or caller writes one. Say what the move needs in the transition's \`reason\`, and core records it`,
    ];
  }
  await writeRecordEvent(
    {
      issueId: comment.issueId,
      actor,
      kind: record.kind,
      contract: record.contract ?? 1,
      fields: record.fields.map((f) => ({ key: f.key, value: f.value })),
      commentId: comment.id,
      at: comment.createdAt,
    },
    tx,
  );
  return [];
}

export async function dropCommentMirror(commentId: string, tx: Tx): Promise<void> {
  await tx.delete(activityLog).where(and(eq(activityLog.dedupeKey, commentMirrorKey(commentId))));
}

/** An edited comment's record replaces the event it was mirrored into, keeping its moment. */
export async function remirrorCommentRecord(
  comment: MirroredComment,
  actor: Actor,
  tx: Tx,
): Promise<string[]> {
  await dropCommentMirror(comment.id, tx);
  return mirrorCommentRecord(comment, actor, tx);
}
