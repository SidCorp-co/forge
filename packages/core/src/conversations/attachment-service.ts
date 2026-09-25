/**
 * The files a room's composer staged, stored and read back.
 *
 * A conversation's own table rather than a fourth use of the session one: a
 * session is a run and a room outlives every run that ever spoke in it. What a
 * message CARRIES is `conversation_messages.images`, whose `ref` is the URL
 * below; this is where the bytes behind that reference live.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { conversationAttachments } from '../db/schema-conversations.js';
import {
  allowedSetForTarget,
  mimeRefusalMessage,
  NAME_MAX_BYTES,
  nameExceedsByteBudget,
  resolveAttachmentMime,
  safeName,
} from '../lib/attachment-mime.js';
import { getStorage } from '../storage/index.js';

export type ConversationAttachmentErrorCode =
  | 'MIME_NOT_ALLOWED'
  | 'FILE_TOO_LARGE'
  | 'EMPTY_FILE'
  | 'INVALID_NAME';

export class ConversationAttachmentError extends Error {
  readonly code: ConversationAttachmentErrorCode;
  readonly details: unknown;
  constructor(code: ConversationAttachmentErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'ConversationAttachmentError';
  }
}

export interface PersistConversationAttachmentInput {
  conversationId: string;
  name: string;
  mime: string;
  bytes: Buffer;
  uploaderId: string;
}

export interface ConversationAttachmentRef {
  id: string;
  conversationId: string;
  name: string;
  mime: string;
  size: number;
  /** Where the bytes are fetched from — what a message's `images[].ref` holds. */
  url: string;
}

export function conversationAttachmentUrl(conversationId: string, id: string): string {
  return `/api/conversations/${conversationId}/attachments/${id}/download`;
}

/**
 * The attachment a stored `ref` names, or null where it names none of this
 * room's. It reads the shape the line above writes rather than parsing a URL,
 * so a ref another venue wrote — Rocket.Chat's, a runner's — resolves to
 * nothing here instead of to a row.
 */
export function attachmentIdFromRef(conversationId: string, ref: string): string | null {
  const prefix = `/api/conversations/${conversationId}/attachments/`;
  const suffix = '/download';
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) return null;
  const id = ref.slice(prefix.length, ref.length - suffix.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/**
 * Validate and store one staged file. The type is decided from the BYTES, so a
 * `.png` that is not one is refused here rather than reaching the model as
 * something it cannot read.
 */
export async function persistConversationAttachment(
  input: PersistConversationAttachmentInput,
): Promise<ConversationAttachmentRef & { createdAt: Date }> {
  const name = safeName(input.name || 'file');
  if (nameExceedsByteBudget(name)) {
    throw new ConversationAttachmentError(
      'INVALID_NAME',
      `name is longer than ${NAME_MAX_BYTES} bytes of UTF-8 — rename the file and upload it again`,
    );
  }
  if (input.bytes.byteLength <= 0) {
    throw new ConversationAttachmentError('EMPTY_FILE', 'empty file');
  }
  if (input.bytes.byteLength > env.UPLOADS_MAX_BYTES) {
    throw new ConversationAttachmentError('FILE_TOO_LARGE', 'file too large');
  }
  const resolved = resolveAttachmentMime({
    target: 'conversation',
    name,
    declaredMime: input.mime,
    bytes: input.bytes,
  });
  if (!resolved.ok) {
    throw new ConversationAttachmentError('MIME_NOT_ALLOWED', mimeRefusalMessage(resolved), {
      reason: resolved.reason,
      allowed: allowedSetForTarget('conversation'),
    });
  }

  const key = `conversations/${input.conversationId}/${Date.now()}-${name}`;
  const { path: storedPath } = await getStorage().put(key, input.bytes, resolved.mime);

  const [row] = await db
    .insert(conversationAttachments)
    .values({
      conversationId: input.conversationId,
      uploaderId: input.uploaderId,
      name,
      path: storedPath,
      mime: resolved.mime,
      size: input.bytes.byteLength,
    })
    .returning({
      id: conversationAttachments.id,
      conversationId: conversationAttachments.conversationId,
      name: conversationAttachments.name,
      mime: conversationAttachments.mime,
      size: conversationAttachments.size,
      createdAt: conversationAttachments.createdAt,
    });
  if (!row) throw new Error('conversation_attachments: insert returned no row');
  return { ...row, url: conversationAttachmentUrl(row.conversationId, row.id) };
}

/**
 * The attachments among `ids` that belong to THIS room. An id belonging to
 * another room is simply absent here — the caller names what is missing, which
 * is what lets the refusal say which id it refused rather than how many.
 */
export async function listConversationAttachmentsByIds(
  conversationId: string,
  ids: readonly string[],
): Promise<ConversationAttachmentRef[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: conversationAttachments.id,
      conversationId: conversationAttachments.conversationId,
      name: conversationAttachments.name,
      mime: conversationAttachments.mime,
      size: conversationAttachments.size,
    })
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.conversationId, conversationId),
        inArray(conversationAttachments.id, [...ids]),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [{ ...row, url: conversationAttachmentUrl(row.conversationId, row.id) }] : [];
  });
}

export interface ConversationAttachmentForFetch {
  id: string;
  conversationId: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  /** Who put it here — carried when a copy of it is made under another owner. */
  uploaderId: string;
}

/** One attachment, for the download route and for the turn that re-reads it. */
export async function loadConversationAttachment(
  conversationId: string,
  attachmentId: string,
): Promise<ConversationAttachmentForFetch | null> {
  const [row] = await db
    .select({
      id: conversationAttachments.id,
      conversationId: conversationAttachments.conversationId,
      name: conversationAttachments.name,
      mime: conversationAttachments.mime,
      size: conversationAttachments.size,
      path: conversationAttachments.path,
      uploaderId: conversationAttachments.uploaderId,
    })
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.conversationId, conversationId),
        eq(conversationAttachments.id, attachmentId),
      ),
    )
    .limit(1);
  return row ?? null;
}
