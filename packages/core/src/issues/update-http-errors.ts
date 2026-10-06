/** The PATCH route's answer to each refusal the issue-field writer raises, by name and status. */

import { HTTPException } from 'hono/http-exception';
import {
  LandingShapeMarkStands,
  SessionContextDropsUnreadKeys,
  SessionContextExpectMismatch,
} from './update-service.js';

export function toHttpUpdateError(err: unknown): unknown {
  if (err instanceof SessionContextDropsUnreadKeys) return sessionContextDrops(err);
  if (err instanceof SessionContextExpectMismatch) return sessionContextMoved(err);
  if (err instanceof LandingShapeMarkStands) return landingShapeMarkStands(err);
  return err;
}

const sessionContextDrops = (err: SessionContextDropsUnreadKeys) =>
  new HTTPException(409, {
    message:
      `this write replaces \`sessionContext\` whole and would remove ${err.dropped.join(', ')}, ` +
      'which it never read. Read the field, add your key to what is there, and send it back complete — ' +
      'or send `expect: { sessionContext: <what you read> }` to say the removal is deliberate.',
    cause: { code: 'SESSION_CONTEXT_DROPS_UNREAD_KEYS', dropped: err.dropped },
  });

const landingShapeMarkStands = (err: LandingShapeMarkStands) =>
  new HTTPException(409, {
    message: err.message,
    cause: {
      code: err.code,
      details: {
        held: err.held,
        sent: err.sent,
        mark: err.mark,
        route: ['unmark', 'landingShape'],
      },
    },
  });

const sessionContextMoved = (err: SessionContextExpectMismatch) =>
  new HTTPException(409, {
    message:
      '`sessionContext` no longer holds the value this write expected — another writer moved it. ' +
      'Re-read it from `details.current`, decide whether your claim still stands, and send the write again with the new `expect`.',
    cause: { code: 'SESSION_CONTEXT_MISMATCH', details: { current: err.current } },
  });
