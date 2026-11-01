// cm:hack — the comment-to-event dual path (ISS-56). The pinned forge-plugin still POSTs every
// record as a ```forge-record comment fence, so a comment carrying one is also written as the
// typed event the readers now read, in the comment's own transaction. Ends when forge-plugin writes
// records to `POST /api/issues/:id/events` (logged in forge-local-docs/plugin-followups.md); then a
// fence in a comment is refused `FORGE_RECORD_IN_COMMENT` and this file goes.

import { isKernelOnlyRecordKind, isRecordEventKind } from '@forge/contracts/record-events';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { activityLog } from '../../db/schema-activity.js';
import { messageRefused } from '../../messaging/contract.js';
import { readForgeRecords } from '../../messaging/forge-record.js';
import { fenceNamed } from '../../messaging/record-screen.js';
import type { Actor } from '../activity.js';
import { recordEventVerdicts } from '../criteria/event-verdicts.js';
import { decisionUntilWarnings } from './decision-until.js';
import { mintRecordQuestion } from './question-record.js';
import { commentMirrorKey, writeRecordEvent } from './store.js';

interface MirroredComment {
  readonly id: string;
  readonly issueId: string;
  readonly body: string;
  readonly createdAt: Date;
}

/** The shape a verdict fence is read in, quoted by the refusal of one that names no criterion. */
const VERDICT_SHAPE =
  'a `verdict` fence holds one block per criterion: `criterion: <n>`, then `verdict: pass | short | fail | skipped` and what it was judged against (`commit:` or `runtime:`)';
const VERDICT_EXAMPLE = [
  '```forge-record',
  'criterion: 1',
  'verdict: pass',
  'commit: 3641ba21fec5096e2d1a91a40f2d9e50e9239068',
  'evidence: judge-log.txt',
  '```',
  'forge-record: verdict · contract 1',
].join('\n');

/**
 * Write the event a comment's record stands for, or return the warning owed where it is stored as
 * prose only: a kind outside the set or a kind core writes (a fence naming no kind is refused at the
 * door, `messaging/record-screen.ts:untaggedFenceRefusal`). A verdict fence that names no criterion
 * block is refused, the comment with it (ISS-786): a verdict accepted and never recorded reads as
 * judged to whoever posted it and as unjudged to every gate.
 * A comment holding several fences reaches here only where every one is a verdict
 * (`comments/screen.ts:screenRecordFence`), and each one is recorded (ISS-608).
 */
export async function mirrorCommentRecord(
  comment: MirroredComment,
  actor: Actor,
  tx: Tx,
): Promise<string[]> {
  const reads = readForgeRecords(comment.body).flatMap(({ index, record }) =>
    record ? [{ index, record }] : [],
  );
  const of = reads.length;
  const [first] = reads;
  if (!first) return [];
  const { record } = first;
  if (of > 1 || record.kind === 'verdict') {
    const written = await recordEventVerdicts(tx, {
      issueId: comment.issueId,
      records: reads.map(({ index, record: r }) => ({ record: r, fence: fenceNamed(index, of) })),
      actor,
      commentId: comment.id,
    });
    const empty = reads.filter((_, at) => written[at] === 0);
    if (empty.length > 0) {
      throw messageRefused(
        'comment-write',
        empty.map(({ index }) => ({
          rule: 'VERDICT_RECORD_EMPTY',
          why: `${fenceNamed(index, of)}this \`forge-record: verdict\` names no criterion with a verdict, so no verdict would be recorded from it and no gate would read one; nothing was stored. Write \`criterion: <n>\` and \`verdict: pass | short | fail | skipped\` in each block, or record it with \`POST /api/issues/:id/verdicts\``,
          quote: '```forge-record',
          shape: VERDICT_SHAPE,
          example: VERDICT_EXAMPLE,
        })),
      );
    }
    return [];
  }
  if (!isRecordEventKind(record.kind)) {
    const named = record.kind ? `kind \`${record.kind}\`` : 'no kind';
    return [
      `RECORD_NOT_TYPED: this comment's \`forge-record\` carries ${named}, so no record event was written for it and no gate will read it — name a record kind on the fence (\`forge-record: <kind> · contract <n>\`), or write it to \`POST /api/issues/:id/events\``,
    ];
  }
  if (isKernelOnlyRecordKind(record.kind)) {
    return [
      `EVENT_KIND_KERNEL_ONLY: this comment's \`forge-record: ${record.kind}\` is stored as prose only — a ${record.kind} record is kernel evidence core writes in the transaction of the move itself, so no comment or caller writes one. Say what the move needs in the transition's \`reason\`, and core records it`,
    ];
  }
  const asked =
    record.kind === 'question' ? await mintRecordQuestion(comment, record, actor, tx) : [];
  const fields = record.fields.map((f) => ({ key: f.key, value: f.value }));
  await writeRecordEvent(
    {
      issueId: comment.issueId,
      actor,
      kind: record.kind,
      contract: record.contract ?? 1,
      fields,
      commentId: comment.id,
      at: comment.createdAt,
    },
    tx,
  );
  return [...asked, ...decisionUntilWarnings(record.kind, fields, comment.createdAt)];
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
