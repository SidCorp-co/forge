const SEPARATOR = '|';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CommentCursor = { createdAtKey: string; id: string };

export function encodeCommentCursor(cursor: CommentCursor): string {
  const raw = `${cursor.createdAtKey}${SEPARATOR}${cursor.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** The cursor a page was read with, or why it is not one; a bad cursor is the request's shape. */
export function decodeCommentCursor(token: string): CommentCursor | { invalid: string } {
  const raw = Buffer.from(token, 'base64url').toString('utf8');
  const at = raw.indexOf(SEPARATOR);
  if (at < 0) return { invalid: 'cursor is not a comment cursor' };

  const id = raw.slice(at + SEPARATOR.length);
  if (!UUID_RE.test(id)) return { invalid: 'cursor carries no comment id' };

  const createdAtKey = raw.slice(0, at);
  if (Number.isNaN(Date.parse(createdAtKey))) {
    return { invalid: 'cursor carries no timestamp' };
  }
  return { createdAtKey, id };
}
