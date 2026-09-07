import { eq, inArray } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { sessionAttachments } from '../db/schema.js';
import {
  allowedSetForTarget,
  mimeRefusalMessage,
  resolveAttachmentMime,
  safeName,
} from '../lib/attachment-mime.js';
import { getStorage } from '../storage/index.js';

export { safeName };

export type SessionAttachmentErrorCode =
  | 'MIME_NOT_ALLOWED'
  | 'FILE_TOO_LARGE'
  | 'EMPTY_FILE'
  | 'INVALID_NAME';

export class SessionAttachmentError extends Error {
  readonly code: SessionAttachmentErrorCode;
  // cm:guard this rides to the client as `body.details`, so it must stay free of storage paths, uploader ids and anything else the refusal does not need
  // cm:why carried on all three attachment error classes so one route mapping reads `err.details` across the union; a session attachment is never refused for a taken name (no record cites one by name), so MIME_NOT_ALLOWED's allowed set is the only thing that ever fills it here
  readonly details: unknown;
  constructor(code: SessionAttachmentErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'SessionAttachmentError';
  }
}

export interface PersistSessionAttachmentInput {
  sessionId: string;
  name: string;
  mime: string;
  bytes: Buffer;
  uploaderId: string;
  uploaderDeviceId: string | null;
}

export interface PersistedSessionAttachment {
  id: string;
  sessionId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: Date;
  url: string;
}

function attachmentUrl(sessionId: string, id: string): string {
  return `/api/agent-sessions/${sessionId}/attachments/${id}/download`;
}

/**
 * Validate + store a single chat-session attachment. Shared by the REST
 * multipart route (web-v2 composer) and the MCP `forge_uploads` presigned path.
 */
export async function persistSessionAttachment(
  input: PersistSessionAttachmentInput,
): Promise<PersistedSessionAttachment> {
  const { sessionId, bytes, uploaderId, uploaderDeviceId } = input;
  const name = safeName(input.name || 'file');
  if (bytes.byteLength <= 0) {
    throw new SessionAttachmentError('EMPTY_FILE', 'empty file');
  }
  if (bytes.byteLength > env.UPLOADS_MAX_BYTES) {
    throw new SessionAttachmentError('FILE_TOO_LARGE', 'file too large');
  }
  const resolved = resolveAttachmentMime({
    target: 'session',
    name,
    declaredMime: input.mime,
    bytes,
  });
  if (!resolved.ok) {
    throw new SessionAttachmentError('MIME_NOT_ALLOWED', mimeRefusalMessage(resolved), {
      reason: resolved.reason,
      allowed: allowedSetForTarget('session'),
    });
  }
  const mime = resolved.mime;

  const key = `sessions/${sessionId}/${Date.now()}-${name}`;
  const { path: storedPath } = await getStorage().put(key, bytes, mime);

  const [inserted] = await db
    .insert(sessionAttachments)
    .values({
      sessionId,
      uploaderId,
      uploaderDeviceId,
      name,
      path: storedPath,
      mime,
      size: bytes.byteLength,
    })
    .returning({
      id: sessionAttachments.id,
      sessionId: sessionAttachments.sessionId,
      name: sessionAttachments.name,
      mime: sessionAttachments.mime,
      size: sessionAttachments.size,
      createdAt: sessionAttachments.createdAt,
    });
  if (!inserted) throw new Error('session_attachments: insert returned no row');

  return {
    ...inserted,
    url: attachmentUrl(inserted.sessionId, inserted.id),
  };
}

/** Shape persisted inline on a chat message (`messages[i].attachments[]`) and
 * sent to the runner in the agent:start/agent:send frame. */
export interface SessionAttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

/**
 * Hydrate attachment refs for a set of ids that belong to one session. Used by
 * `dispatchChatTurn` to stamp `userMessage.attachments` (re-render) and build
 * the WS frame's `attachments[]`. Ids not belonging to the session are dropped.
 */
export async function listSessionAttachmentsByIds(
  sessionId: string,
  ids: string[],
): Promise<SessionAttachmentRef[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: sessionAttachments.id,
      sessionId: sessionAttachments.sessionId,
      name: sessionAttachments.name,
      mime: sessionAttachments.mime,
      size: sessionAttachments.size,
    })
    .from(sessionAttachments)
    .where(inArray(sessionAttachments.id, ids));

  const wanted = new Set(ids);
  return rows
    .filter((r) => r.sessionId === sessionId && wanted.has(r.id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      mime: r.mime,
      size: r.size,
      url: attachmentUrl(r.sessionId, r.id),
    }));
}

interface SessionAttachmentForFetch {
  name: string;
  mime: string;
  size: number;
  path: string;
  sessionId: string;
}

/** Load a single session attachment (for the download route + MCP fetch). */
export async function loadSessionAttachment(
  attachmentId: string,
): Promise<SessionAttachmentForFetch | null> {
  const [row] = await db
    .select({
      name: sessionAttachments.name,
      mime: sessionAttachments.mime,
      size: sessionAttachments.size,
      path: sessionAttachments.path,
      sessionId: sessionAttachments.sessionId,
    })
    .from(sessionAttachments)
    .where(eq(sessionAttachments.id, attachmentId))
    .limit(1);
  return row ?? null;
}
