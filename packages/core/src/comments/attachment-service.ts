import type { AttachmentRefusalCode } from '@forge/contracts/attachments';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { commentAttachments } from '../db/schema.js';
import {
  allowedSetForTarget,
  mimeRefusalMessage,
  NAME_MAX_BYTES,
  nameExceedsByteBudget,
  resolveAttachmentMime,
  safeName,
} from '../lib/attachment-mime.js';
import { lockAttachmentName, type NameCheckExecutor } from '../lib/attachment-name-lock.js';
import type { ExistingAttachmentRef } from '../lib/attachment-refs.js';
import { type RefusalError, refuser } from '../lib/refusal.js';
import { getStorage } from '../storage/index.js';

export { safeName };

const refuse = refuser<AttachmentRefusalCode>('ATTACHMENT_REFUSED');

/**
 * Everything a comment attachment is refused for, decided without touching
 * storage or the DB. Returns the type the row will be stored under, read from
 * the BYTES and only then narrowed by the name (ISS-957).
 */
export function validateCommentAttachment(input: {
  name: string;
  mime: string;
  bytes: Buffer;
}): string {
  if (!input.name) throw refuse('INVALID_NAME', 'name is empty after sanitisation');
  if (nameExceedsByteBudget(input.name))
    throw refuse(
      'INVALID_NAME',
      `name is longer than ${NAME_MAX_BYTES} bytes of UTF-8 — rename the file and upload it again`,
    );
  if (input.bytes.byteLength <= 0) throw refuse('EMPTY_FILE', 'empty file');
  if (input.bytes.byteLength > env.UPLOADS_MAX_BYTES)
    throw refuse(
      'FILE_TOO_LARGE',
      `file too large: ${input.bytes.byteLength} bytes, at most ${env.UPLOADS_MAX_BYTES}`,
    );

  const resolved = resolveAttachmentMime({
    target: 'comment',
    name: input.name,
    declaredMime: input.mime,
    bytes: input.bytes,
  });
  if (!resolved.ok) {
    throw refuse(
      'MIME_NOT_ALLOWED',
      `${mimeRefusalMessage(resolved)}; a comment takes ${allowedSetForTarget('comment').mimes.join(
        ', ',
      )}`,
    );
  }
  return resolved.mime;
}

function nameTakenError(existing: ExistingAttachmentRef, scope: string): RefusalError {
  return refuse(
    'ATTACHMENT_NAME_TAKEN',
    `an attachment named "${existing.name}" is already on this ${scope} (id ${existing.id}) — cite it or upload under a different name`,
    '/name',
  );
}

/**
 * The oldest attachment on this comment stored under exactly `name`, or null.
 *
 * Scoped to the one comment, not the issue: a comment is written once with its
 * files, and two comments in a thread may each carry their own `output.txt`.
 */
export async function findCommentAttachmentByName(
  commentId: string,
  name: string,
  executor: NameCheckExecutor = db,
): Promise<ExistingAttachmentRef | null> {
  const [row] = await executor
    .select({ id: commentAttachments.id, name: commentAttachments.name })
    .from(commentAttachments)
    .where(and(eq(commentAttachments.commentId, commentId), eq(commentAttachments.name, name)))
    .orderBy(asc(commentAttachments.createdAt))
    .limit(1);
  if (!row) return null;
  return { id: row.id, name: row.name, url: `/api/comments/attachments/${row.id}` };
}

export interface PersistCommentAttachmentInput {
  commentId: string;
  name: string;
  mime: string;
  bytes: Buffer;
  uploaderId: string;
  uploaderDeviceId: string | null;
}

export interface PersistedCommentAttachment {
  id: string;
  commentId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: Date;
  url: string;
}

/**
 * Validate + store a single comment attachment for every REST door that
 * uploads one, so each row renders the same way in the web UI.
 */
export async function persistCommentAttachment(
  input: PersistCommentAttachmentInput,
): Promise<PersistedCommentAttachment> {
  const { commentId, bytes, uploaderId, uploaderDeviceId } = input;
  const name = safeName(input.name || 'file');
  const mime = validateCommentAttachment({ name, mime: input.mime, bytes });

  const inserted = await db.transaction(async (tx) => {
    await lockAttachmentName(tx, 'comment', commentId, name);

    const taken = await findCommentAttachmentByName(commentId, name, tx);
    if (taken) throw nameTakenError(taken, 'comment');

    const key = `comments/${commentId}/${Date.now()}-${name}`;
    const { path: storedPath } = await getStorage().put(key, bytes, mime);

    const [row] = await tx
      .insert(commentAttachments)
      .values({
        commentId,
        uploaderId,
        uploaderDeviceId,
        name,
        path: storedPath,
        mime,
        size: bytes.byteLength,
      })
      .returning({
        id: commentAttachments.id,
        commentId: commentAttachments.commentId,
        name: commentAttachments.name,
        mime: commentAttachments.mime,
        size: commentAttachments.size,
        createdAt: commentAttachments.createdAt,
      });
    return row;
  });
  if (!inserted) throw new Error('comment_attachments: insert returned no row');

  return {
    ...inserted,
    url: `/api/comments/attachments/${inserted.id}`,
  };
}

/** Remove attachments this process wrote and no longer stands behind (storage and rows). */
export async function discardCommentAttachments(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: commentAttachments.id, path: commentAttachments.path })
    .from(commentAttachments)
    .where(inArray(commentAttachments.id, [...ids]));
  for (const row of rows) {
    try {
      await getStorage().delete(row.path);
    } catch {}
  }
  await db.delete(commentAttachments).where(inArray(commentAttachments.id, [...ids]));
}
