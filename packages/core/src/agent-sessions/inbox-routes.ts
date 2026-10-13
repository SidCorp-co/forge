import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/describe.js';
import { zValidator } from '../api-reference/validator.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import type { AuthVars } from '../middleware/auth.js';
import * as ref from './inbox-routes-reference.js';
import { okSchema } from './routes-reference.js';
import { confirmSessionSend, markSessionSendApplied } from './session-send.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });
const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const agentSessionInboxRoutes = new Hono<{ Variables: AuthVars }>();

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
  ref.ackInboxSend,
  zValidator('param', ref.paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', ref.ackBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id, seq } = c.req.valid('param');
    await assertOwnsSession(id, c);
    await confirmSessionSend(id, seq, c.req.valid('json').outcome);
    return c.json(answer(okSchema, { ok: true }));
  },
);

agentSessionInboxRoutes.post(
  '/:id/inbox/:seq/applied',
  ref.applyInboxSend,
  zValidator('param', ref.paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', ref.appliedBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id, seq } = c.req.valid('param');
    await assertOwnsSession(id, c);
    await markSessionSendApplied(id, seq, c.req.valid('json').turn);
    return c.json(answer(okSchema, { ok: true }));
  },
);
