// RFC 0003 — the two facts the runner reports back about one inbox message.
//
// They are deliberately separate endpoints because they are separate claims.
// `ack` says what happened to the WRITE ("I put this on the CLI's stdin", or
// "there is no live session here"). `applied` says a completed turn consumed
// it. Only the second lets a caller stand down the durable path it armed when
// it sent — a `delivered` message whose session dies before the turn finishes
// was never read by the model.
//
// Both are the runner's own report about a process it owns, so both are gated
// on the reporting device owning the session — see the guard on
// `assertOwnsSession`, which is where a user principal is refused too.

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import type { AuthVars } from '../middleware/auth.js';
import { confirmSessionSend, markSessionSendApplied } from './session-send.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });
const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const agentSessionInboxRoutes = new Hono<{ Variables: AuthVars }>();

const paramSchema = z.object({ id: z.uuid(), seq: z.coerce.number().int().positive() });

// cm:guard this ONE comparison is both gates, and there is deliberately no separate `principal === 'device'` line above it: a user principal leaves `deviceId` unset, so it can never equal a session's, and a second check for it would be a line no assertion could ever turn red. Every paired runner in the fleet holds a valid device token, so without the session lookup any of them could ack another box's episode — and a forged `delivered` is what stops core falling back, losing a human's answer with no trace.
async function assertOwnsSession(sessionId: string, c: { get: (k: 'deviceId') => unknown }) {
  const [row] = await db
    .select({ deviceId: agentSessions.deviceId })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!row || row.deviceId !== c.get('deviceId')) throw forbidden('session is not on this device');
}

agentSessionInboxRoutes.post(
  '/:id/inbox/:seq/ack',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', z.object({ outcome: z.enum(['delivered', 'gone']) }), (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id, seq } = c.req.valid('param');
    await assertOwnsSession(id, c);
    // cm:guard `unknown` is NOT accepted here on purpose — it is core's word for "the runner never answered", and a runner that could report it would be claiming silence it is in the act of breaking. See the outcome guard in db/schema-session-inbox.ts.
    await confirmSessionSend(id, seq, c.req.valid('json').outcome);
    return c.json({ ok: true });
  },
);

agentSessionInboxRoutes.post(
  '/:id/inbox/:seq/applied',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', z.object({ turn: z.number().int().nonnegative() }), (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id, seq } = c.req.valid('param');
    await assertOwnsSession(id, c);
    await markSessionSendApplied(id, seq, c.req.valid('json').turn);
    return c.json({ ok: true });
  },
);
