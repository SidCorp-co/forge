/**
 * The files a room's composer staged, stored and read back.
 *
 * A conversation's own table rather than a fourth use of the session one: a
 * session is a run and a room outlives every run that ever spoke in it. What a
 * message CARRIES is `conversation_messages.images`, whose `ref` is the URL
 * below; this is where the bytes behind that reference live.
 */

import {
  CONVERSATION_DOCUMENT_MIMES,
  conversationAcceptedList,
  conversationAttachmentType,
  formatAttachmentCap,
} from '@forge/contracts/attachments';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conversationAttachments } from '../db/schema-conversations.js';
import { getStorage } from '../integrations/index.js';
import {
  allowedSetForTarget,
  mimeRefusalMessage,
  NAME_MAX_BYTES,
  nameExceedsByteBudget,
  resolveAttachmentMime,
  safeName,
} from '../lib/attachment-mime.js';
import { isDocumentMime, readDocumentText } from '../lib/document-text.js';
import { env } from '../lib/env.js';
import { refuseConversation } from './refusals.js';

interface PersistConversationAttachmentInput {
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

function conversationAttachmentUrl(conversationId: string, id: string): string {
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
 * The bytes a document is stored as. Its text is read now, so a file the assistant could never read
 * — a scanned PDF, a broken one — is refused while the person is still there to attach another,
 * rather than at the turn that needed it. A text document is stored scrubbed: the secret it carried
 * never reaches storage, the model or a box. A PDF or a Word file is stored as sent, since its bytes
 * cannot be rewritten, and its text is scrubbed wherever it is read (`lib/document-text.ts`).
 */
async function documentBytesToStore(name: string, mime: string, bytes: Buffer): Promise<Buffer> {
  const read = await readDocumentText(bytes, mime);
  if (!read.ok) {
    throw refuseConversation(
      'DOCUMENT_UNREADABLE',
      `${name} (${mime}) cannot be read as a document: ${read.reason}`,
      '/file',
    );
  }
  const rewritable = mime.startsWith('text/') || mime === 'application/json';
  return read.redacted && rewritable ? Buffer.from(read.text, 'utf8') : bytes;
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
    throw refuseConversation(
      'INVALID_NAME',
      `name is longer than ${NAME_MAX_BYTES} bytes of UTF-8 — rename the file and upload it again`,
      '/name',
    );
  }
  if (input.bytes.byteLength <= 0) {
    throw refuseConversation('EMPTY_FILE', 'empty file: an attachment carries at least one byte');
  }
  if (input.bytes.byteLength > env.UPLOADS_MAX_BYTES) {
    throw refuseConversation(
      'FILE_TOO_LARGE',
      `file too large: ${name} is ${input.bytes.byteLength} bytes, and an attachment here is at most ${env.UPLOADS_MAX_BYTES}; a conversation takes ${conversationAcceptedList(env.UPLOADS_MAX_BYTES)}`,
    );
  }
  const resolved = resolveAttachmentMime({
    target: 'conversation',
    name,
    declaredMime: input.mime,
    bytes: input.bytes,
  });
  if (!resolved.ok) {
    throw refuseConversation(
      'MIME_NOT_ALLOWED',
      `${name}: ${mimeRefusalMessage(resolved)}; a conversation takes ${conversationAcceptedList(env.UPLOADS_MAX_BYTES)} (${allowedSetForTarget('conversation').mimes.join(', ')})`,
      '/mime',
    );
  }
  const cap = Math.min(
    conversationAttachmentType(resolved.mime)?.maxBytes ?? env.UPLOADS_MAX_BYTES,
    env.UPLOADS_MAX_BYTES,
  );
  if (input.bytes.byteLength > cap) {
    throw refuseConversation(
      'FILE_TOO_LARGE',
      `file too large: ${name} is ${input.bytes.byteLength} bytes of ${resolved.mime}, and a conversation takes ${resolved.mime} up to ${formatAttachmentCap(cap)} (${cap} bytes); it takes ${conversationAcceptedList(env.UPLOADS_MAX_BYTES)}`,
    );
  }
  const bytes = isDocumentMime(resolved.mime)
    ? await documentBytesToStore(name, resolved.mime, input.bytes)
    : input.bytes;

  const key = `conversations/${input.conversationId}/${Date.now()}-${name}`;
  const { path: storedPath } = await getStorage().put(key, bytes, resolved.mime);

  const [row] = await db
    .insert(conversationAttachments)
    .values({
      conversationId: input.conversationId,
      uploaderId: input.uploaderId,
      name,
      path: storedPath,
      mime: resolved.mime,
      size: bytes.byteLength,
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

interface ConversationAttachmentForFetch {
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

/** The documents a room holds, newest first — what a turn reads a named file from. */
export async function listConversationDocuments(
  conversationId: string,
): Promise<ConversationAttachmentForFetch[]> {
  return db
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
        inArray(conversationAttachments.mime, [...CONVERSATION_DOCUMENT_MIMES]),
      ),
    )
    .orderBy(desc(conversationAttachments.createdAt));
}
