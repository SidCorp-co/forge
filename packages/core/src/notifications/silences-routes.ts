/**
 * ISS-1063 — silences: an operator already working on something stops being told about
 * it, until a deadline they state.
 *
 * Alertmanager's silences, minus the parts that need a rota. Two things make this safe
 * where turning a type off is not: `expiresAt` is required, so nothing has to remember to
 * turn it back on; and no pass deletes an expired row, so what was silenced and for how
 * long is still readable afterwards.
 */

import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { notificationSilences, notificationTypes } from '../db/schema.js';
import type { AuthVars } from '../middleware/auth.js';

const MAX_SILENCE_MS = 7 * 24 * 60 * 60 * 1000;

const createSchema = z
  .object({
    type: z.enum(notificationTypes).optional(),
    projectId: z.uuid().optional(),
    resolutionKey: z.string().min(1).max(500).optional(),
    reason: z.string().min(1).max(500),
    expiresAt: z.iso.datetime(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const silenceRoutes = new Hono<{ Variables: AuthVars }>();

silenceRoutes.get('/', async (c) => {
  const rows = await db
    .select()
    .from(notificationSilences)
    .where(
      and(
        eq(notificationSilences.createdBy, c.get('userId')),
        gt(notificationSilences.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(notificationSilences.createdAt));
  return c.json(rows);
});

silenceRoutes.post(
  '/',
  zValidator('json', createSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const body = c.req.valid('json');
    const expiresAt = new Date(body.expiresAt);
    const ms = expiresAt.getTime() - Date.now();
    if (ms <= 0 || ms > MAX_SILENCE_MS) {
      throw badRequest({
        expiresAt:
          'must be in the future and no more than 7 days out — a silence with no end is a type turned off with nobody accountable for turning it back on',
      });
    }
    const [row] = await db
      .insert(notificationSilences)
      .values({
        createdBy: c.get('userId'),
        type: body.type ?? null,
        projectId: body.projectId ?? null,
        resolutionKey: body.resolutionKey ?? null,
        reason: body.reason,
        expiresAt,
      })
      .returning();
    return c.json(row, 201);
  },
);

silenceRoutes.delete(
  '/:id',
  zValidator('param', z.object({ id: z.uuid() }), (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const updated = await db
      .update(notificationSilences)
      .set({ expiresAt: new Date() })
      .where(
        and(
          eq(notificationSilences.id, c.req.valid('param').id),
          eq(notificationSilences.createdBy, c.get('userId')),
        ),
      )
      .returning({ id: notificationSilences.id });
    if (updated.length === 0) {
      throw new HTTPException(404, { message: 'silence not found', cause: { code: 'NOT_FOUND' } });
    }
    return c.body(null, 204);
  },
);
