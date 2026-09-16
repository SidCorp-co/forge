/**
 * The cursor a comment thread is walked with — one codec, both transports.
 *
 * ISS-956: a thread was readable only as far as one response would carry, on
 * REST by a fixed row cap and on MCP by the output-size budget, and neither
 * answer said where to resume. The key is `(createdAt, id)` rather than
 * `createdAt` alone because two comments written in the same instant are
 * ordinary on an agent-written thread, and a timestamp-only cursor either
 * repeats one of them or skips it.
 */

const SEPARATOR = '|';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CommentCursor = { createdAtKey: string; id: string };

export class CommentCursorInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommentCursorInvalidError';
  }
}

export function encodeCommentCursor(cursor: CommentCursor): string {
  const raw = `${cursor.createdAtKey}${SEPARATOR}${cursor.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeCommentCursor(token: string): CommentCursor {
  const raw = Buffer.from(token, 'base64url').toString('utf8');
  const at = raw.indexOf(SEPARATOR);
  if (at < 0) throw new CommentCursorInvalidError('cursor is not a comment cursor');

  const id = raw.slice(at + SEPARATOR.length);
  if (!UUID_RE.test(id)) throw new CommentCursorInvalidError('cursor carries no comment id');

  const createdAtKey = raw.slice(0, at);
  if (Number.isNaN(Date.parse(createdAtKey))) {
    throw new CommentCursorInvalidError('cursor carries no timestamp');
  }
  return { createdAtKey, id };
}
