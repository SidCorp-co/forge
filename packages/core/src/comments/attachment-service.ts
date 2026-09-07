import { and, asc, eq, inArray } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { commentAttachments, comments } from '../db/schema.js';
import {
  allowedSetForTarget,
  mimeRefusalMessage,
  resolveAttachmentMime,
  safeName,
} from '../lib/attachment-mime.js';
import type { ExistingAttachmentRef } from '../lib/attachment-refs.js';
import { getStorage } from '../storage/index.js';
import type { CommentAttachmentLite } from './tree.js';

export { safeName };

export type AttachmentErrorCode =
  | 'MIME_NOT_ALLOWED'
  | 'FILE_TOO_LARGE'
  | 'EMPTY_FILE'
  | 'INVALID_NAME'
  | 'ATTACHMENT_NAME_TAKEN';

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;
  // cm:guard every route that maps this class must forward `details` — an ATTACHMENT_NAME_TAKEN whose body drops it names a collision without naming what it collided with, and a MIME_NOT_ALLOWED whose body drops it names a type without naming the set (ISS-957, ISS-963)
  // cm:guard this rides to the client as `body.details`, so it must stay free of storage paths, uploader ids and anything else the refusal does not need
  readonly details: unknown;
  constructor(code: AttachmentErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'AttachmentError';
  }
}

/**
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
  if (!input.name) throw new AttachmentError('INVALID_NAME', 'name is empty after sanitisation');
  if (input.bytes.byteLength <= 0) throw new AttachmentError('EMPTY_FILE', 'empty file');
  if (input.bytes.byteLength > env.UPLOADS_MAX_BYTES)
    throw new AttachmentError('FILE_TOO_LARGE', 'file too large');

  const resolved = resolveAttachmentMime({
    target: 'comment',
    name: input.name,
    declaredMime: input.mime,
    bytes: input.bytes,
  });
  if (!resolved.ok) {
    throw new AttachmentError('MIME_NOT_ALLOWED', mimeRefusalMessage(resolved), {
      reason: resolved.reason,
      allowed: allowedSetForTarget('comment'),
    });
  }
  return resolved.mime;
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
): Promise<ExistingAttachmentRef | null> {
  const [row] = await db
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
 * Validate + store a single comment attachment. Shared by the REST multipart
 * route and the MCP `forge_comments` create path. Behaviour must stay
 * byte-identical to the legacy inline REST code so the web UI keeps rendering
 * MCP-uploaded rows the same way (see ISS-93 AC #4).
 */
export async function persistCommentAttachment(
  input: PersistCommentAttachmentInput,
): Promise<PersistedCommentAttachment> {
  const { commentId, bytes, uploaderId, uploaderDeviceId } = input;
  const name = safeName(input.name || 'file');
  const mime = validateCommentAttachment({ name, mime: input.mime, bytes });

  // cm:guard decide the collision on the SANITISED name, never `input.name` — that is what the row stores and what a record cites, and `a b.md`/`a_b.md` both sanitise to `a_b.md`, so checking the input would admit the pairs that actually collide and refuse the pairs that do not (ISS-963)
  const taken = await findCommentAttachmentByName(commentId, name);
  if (taken) {
    throw new AttachmentError(
      'ATTACHMENT_NAME_TAKEN',
      `an attachment named "${taken.name}" is already on this comment (id ${taken.id}) — cite it or upload under a different name`,
      { existing: taken },
    );
  }

  const key = `comments/${commentId}/${Date.now()}-${name}`;
  const { path: storedPath } = await getStorage().put(key, bytes, mime);

  const [inserted] = await db
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
  if (!inserted) throw new Error('comment_attachments: insert returned no row');

  return {
    ...inserted,
    url: `/api/comments/attachments/${inserted.id}`,
  };
}

export interface CommentAttachmentErrorEntry {
  index: number;
  name: string;
  code: AttachmentErrorCode | 'INTERNAL';
  message: string;
  details?: unknown;
}

function toErrorEntry(index: number, name: string, err: unknown): CommentAttachmentErrorEntry {
  return err instanceof AttachmentError
    ? { index, name, code: err.code, message: err.message, details: err.details }
    : {
        index,
        name,
        code: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      };
}

// cm:edge protocol -> packages/core/src/issues/attachment-service.ts — the issue twin of this function; the two must refuse a batch on the same terms, because one client sends the same evidence to an issue or to a comment and cannot be told the rules differ by parent
async function discardCommentAttachments(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: commentAttachments.id, path: commentAttachments.path })
    .from(commentAttachments)
    .where(inArray(commentAttachments.id, [...ids]));
  for (const row of rows) {
    try {
      await getStorage().delete(row.path);
    } catch {
      // cm:why swallowed on purpose, and the row is deleted below regardless: the two failures are not symmetrical — an orphan blob costs storage and is recoverable by a sweep, while a row surviving a refused batch is the half-landed attachment this whole path promises cannot exist, under a name the caller can no longer re-send.
    }
  }
  await db.delete(commentAttachments).where(inArray(commentAttachments.id, [...ids]));
}

/**
 * Persist a pre-decoded batch onto a comment, whole or not at all (ISS-957).
 * The issue twin's contract, applied to the second parent: every member is
 * judged before any lands, and a failure during the persist loop is rolled
 * back, so a comment never carries half the evidence it was written to carry.
 */
export async function persistDecodedCommentAttachments(
  commentId: string,
  decoded: readonly { name: string; mime: string; bytes: Buffer }[],
  uploaderId: string,
  uploaderDeviceId: string | null,
): Promise<{ persisted: PersistedCommentAttachment[]; errors: CommentAttachmentErrorEntry[] }> {
  const errors: CommentAttachmentErrorEntry[] = [];
  for (const [i, d] of decoded.entries()) {
    try {
      validateCommentAttachment({
        name: safeName(d.name || 'file'),
        mime: d.mime,
        bytes: d.bytes,
      });
    } catch (err) {
      errors.push(toErrorEntry(i, d.name, err));
    }
  }
  if (errors.length > 0) return { persisted: [], errors };

  const persisted: PersistedCommentAttachment[] = [];
  for (const [i, d] of decoded.entries()) {
    try {
      persisted.push(
        await persistCommentAttachment({
          commentId,
          name: d.name,
          mime: d.mime,
          bytes: d.bytes,
          uploaderId,
          uploaderDeviceId,
        }),
      );
    } catch (err) {
      await discardCommentAttachments(persisted.map((a) => a.id));
      return { persisted: [], errors: [toErrorEntry(i, d.name, err)] };
    }
  }
  return { persisted, errors };
}

/**
 * Group every attachment on an issue's comments by commentId. Shared by the
 * REST comment-tree endpoint (`comments/routes.ts`) and the MCP read surfaces
 * (`forge_comments.list`, `forge_step_start`) so all three render the same
 * `{id,name,mime,size,url,createdAt}` rows from one query. Comments with no
 * attachment simply have no map entry (caller defaults to `[]`).
 */
export async function listCommentAttachmentsForIssue(
  issueId: string,
): Promise<Map<string, CommentAttachmentLite[]>> {
  const rows = await db
    .select({
      id: commentAttachments.id,
      commentId: commentAttachments.commentId,
      name: commentAttachments.name,
      mime: commentAttachments.mime,
      size: commentAttachments.size,
      createdAt: commentAttachments.createdAt,
    })
    .from(commentAttachments)
    .innerJoin(comments, eq(comments.id, commentAttachments.commentId))
    .where(eq(comments.issueId, issueId))
    .orderBy(asc(commentAttachments.createdAt));

  const byCommentId = new Map<string, CommentAttachmentLite[]>();
  for (const a of rows) {
    const list = byCommentId.get(a.commentId) ?? [];
    list.push({
      id: a.id,
      name: a.name,
      mime: a.mime,
      size: a.size,
      createdAt: a.createdAt,
      url: `/api/comments/attachments/${a.id}`,
    });
    byCommentId.set(a.commentId, list);
  }
  return byCommentId;
}
