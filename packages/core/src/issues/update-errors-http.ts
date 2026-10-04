import { HTTPException } from 'hono/http-exception';
import { notFound } from '../middleware/route-errors.js';
import { heldTakeRefusal } from './blocked-by.js';
import {
  IssueUpdateNotFound,
  SessionContextDropsUnreadKeys,
  SessionContextExpectMismatch,
} from './update-service.js';

const sessionContextDrops = (err: SessionContextDropsUnreadKeys) =>
  new HTTPException(409, {
    message:
      `this write replaces \`sessionContext\` whole and would remove ${err.dropped.join(', ')}, ` +
      'which it never read. Read the field, add your key to what is there, and send it back complete — ' +
      'or send `expect: { sessionContext: <what you read> }` to say the removal is deliberate.',
    cause: { code: 'SESSION_CONTEXT_DROPS_UNREAD_KEYS', dropped: err.dropped },
  });

const sessionContextMoved = (err: SessionContextExpectMismatch) =>
  new HTTPException(409, {
    message:
      '`sessionContext` no longer holds the value this write expected — another writer moved it. ' +
      'Re-read it from `details.current`, decide whether your claim still stands, and send the write again with the new `expect`.',
    cause: { code: 'SESSION_CONTEXT_MISMATCH', details: { current: err.current } },
  });

export function heldTakeHttp(err: unknown): HTTPException | null {
  const refused = heldTakeRefusal(err);
  if (!refused) return null;
  return new HTTPException(409, {
    message: refused.message,
    cause: { code: refused.code, details: { blocked: refused.blocked } },
  });
}

export function toHttpUpdateError(err: unknown): unknown {
  if (err instanceof IssueUpdateNotFound) return notFound('issue not found');
  if (err instanceof SessionContextDropsUnreadKeys) return sessionContextDrops(err);
  if (err instanceof SessionContextExpectMismatch) return sessionContextMoved(err);
  return heldTakeHttp(err) ?? err;
}
