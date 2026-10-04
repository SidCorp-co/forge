/**
 * ISS-1063 — silences: an operator already working on something stops being told about
 * it, until a deadline they state.
 *
 * Alertmanager's silences, minus the parts that need a rota. Two things make this safe
 * where turning a type off is not: `expiresAt` is required, so nothing has to remember to
 * turn it back on; and no pass deletes an expired row, so what was silenced and for how
 * long is still readable afterwards.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { notificationTypes } from '../db/schema.js';
import type { AuthVars } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { listActiveSilences } from './read.js';
import { createSilence, endSilence } from './service.js';

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

silenceRoutes.get('/', async (c) => c.json(await listActiveSilences(c.get('userId'))));

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
    const row = await createSilence({
      createdBy: c.get('userId'),
      type: body.type ?? null,
      projectId: body.projectId ?? null,
      resolutionKey: body.resolutionKey ?? null,
      reason: body.reason,
      expiresAt,
    });
    return c.json(row, 201);
  },
);

silenceRoutes.delete(
  '/:id',
  zValidator('param', z.object({ id: z.uuid() }), (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const ended = await endSilence(c.req.valid('param').id, c.get('userId'));
    if (!ended) {
      throw new HTTPException(404, { message: 'silence not found', cause: { code: 'NOT_FOUND' } });
    }
    return c.body(null, 204);
  },
);
