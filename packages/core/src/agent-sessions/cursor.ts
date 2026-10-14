const SEPARATOR = '|';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a project's session list resumes: strictly after the row at `(updatedAtKey, id)`. */
export type SessionCursor = { updatedAtKey: string; id: string };

export class SessionCursorInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionCursorInvalidError';
  }
}

export function encodeSessionCursor(cursor: SessionCursor): string {
  return Buffer.from(`${cursor.updatedAtKey}${SEPARATOR}${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/** Refuses a token this list did not mint, naming what is missing from it. */
export function decodeSessionCursor(token: string): SessionCursor {
  const raw = Buffer.from(token, 'base64url').toString('utf8');
  const at = raw.indexOf(SEPARATOR);
  if (at < 0) throw new SessionCursorInvalidError('cursor is not an agent-session cursor');

  const id = raw.slice(at + SEPARATOR.length);
  if (!UUID_RE.test(id)) throw new SessionCursorInvalidError('cursor carries no session id');

  const updatedAtKey = raw.slice(0, at);
  if (Number.isNaN(Date.parse(updatedAtKey))) {
    throw new SessionCursorInvalidError('cursor carries no timestamp');
  }
  return { updatedAtKey, id };
}
