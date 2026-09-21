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
