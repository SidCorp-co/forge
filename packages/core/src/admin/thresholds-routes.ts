/**
 * ISS-654 — GET/PUT /api/admin/thresholds, the write surface for the Ops
 * Console's Tier 1 thresholds and spend ceiling.
 *
 * Own `requireAdmin()` router (mirrors `alert-routes.ts`) so it is importable
 * standalone in an integration test. Reading lives in `thresholds.ts`; this
 * file only validates the body and upserts the singleton.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ADMIN_THRESHOLDS_ID, adminThresholds } from '../db/schema-admin-thresholds.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { readThresholds } from './thresholds.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

// cm:guard every field optional and `.strict()` — a PUT is a partial patch over the effective row, so a client that knows one key never has to round-trip the others; strict is what turns a typo'd key into a 400 instead of a silent no-op the operator reads back as "my ceiling did not save".
const thresholdsBodySchema = z
  .object({
    stuckJobSeconds: z.number().int().min(60).max(86_400),
    runnerStarvedSeconds: z.number().int().min(30).max(86_400),
    spendCeilingUsdDay: z.number().positive().max(1_000_000).nullable(),
    spendSpikeMultiple: z.number().min(1.1).max(100),
    scheduleFailStreak: z.number().int().min(1).max(100),
    deliveryFailRatePct: z.number().int().min(1).max(100),
    interventionLabels: z.array(z.string().trim().min(1).max(100)).max(50),
    ghostRunnerOfflineDays: z.number().int().min(1).max(365),
  })
  .partial()
  .strict();

export const adminThresholdRoutes = new Hono<{ Variables: AuthVars }>();
adminThresholdRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

adminThresholdRoutes.get('/thresholds', async (c) => c.json(await readThresholds()));

adminThresholdRoutes.put(
  '/thresholds',
  zValidator('json', thresholdsBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const patch = c.req.valid('json');
    // cm:guard merge over the EFFECTIVE row, not over the table defaults — the first PUT inserts, so patching a single key against an absent row would otherwise write the column defaults for every other key and quietly discard nothing, while the second PUT would discard the first one's work.
    const next = { ...(await readThresholds()), ...patch };
    await db
      .insert(adminThresholds)
      .values({
        id: ADMIN_THRESHOLDS_ID,
        ...next,
        updatedBy: c.get('userId'),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: adminThresholds.id,
        set: { ...next, updatedBy: c.get('userId'), updatedAt: new Date() },
      });
    return c.json(next);
  },
);
