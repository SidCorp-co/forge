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

// cm:guard `createdAtKey` is the DB's OWN rendering of `created_at` to the microsecond, carried as text and never as a `Date`. Postgres stores microseconds and a JS `Date` holds milliseconds, so a token minted from a `Date` names an instant at or before its own row: the row the cursor came from re-matches `created_at > token`, and every page repeats the previous page's last root — measured 47 rows read off a 40-comment thread at limit 7 (ISS-956). Comparing text-to-`timestamptz` in SQL keeps the key exact AND keeps the thread's display order at the precision it was written in.
export type CommentCursor = { createdAtKey: string; id: string };

export class CommentCursorInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommentCursorInvalidError';
  }
}

// cm:edge contract -> packages/core/src/mcp/tools/forge-comments.ts — REST and MCP both mint and both accept, so a token either one issues must decode in the other. AC 12 measures exactly that, and it is why the codec is here rather than beside a route.
export function encodeCommentCursor(cursor: CommentCursor): string {
  const raw = `${cursor.createdAtKey}${SEPARATOR}${cursor.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

// cm:guard a token that does not decode THROWS — never falls back to the first page. A cursor silently ignored restarts the walk, so a client paging a long thread loops over the same rows forever and reads it as a thread that never ends. Each transport maps this to its own refusal (REST 400, MCP BAD_REQUEST).
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
