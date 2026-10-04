/**
 * ISS-1056 — the one door that runs a project's weekly reading NOW: an org owner or admin who
 * flipped the toggle sees the first report without waiting for the 04:00 UTC tick. It runs the
 * same `runAssistantWeeklyForProject` the cron does, for this project only, under the same window
 * and the same already-posted check — so pressing it twice posts once.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { zValidator } from '../../middleware/zod-validator.js';
import { weeklyProjectOf } from '../read.js';
import { refuseAssistant } from '../refusals.js';
import { readAssistantWeekly } from './config.js';
import { realDeps, runAssistantWeeklyForProject } from './run.js';
import { requireOrgHeld } from '../../permissions/index.js';

const idParamSchema = z.object({ id: z.uuid() });

export const assistantWeeklyRoutes = new Hono<{ Variables: AuthVars }>();
assistantWeeklyRoutes.use('*', requireAuth(), assertEmailVerified());

assistantWeeklyRoutes.post(
  '/:id/assistant-weekly/run',
  zValidator('param', idParamSchema, (result, c) => {
    if (!result.success)
      return c.json(
        { code: 'BAD_REQUEST', message: 'Invalid input', details: z.flattenError(result.error) },
        400,
      );
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const access = await loadProjectAccess(id, c.get('userId'));
    requireOrgHeld(access.orgId, access.orgRole, 'org.admin');
    const row = await weeklyProjectOf(id);
    if (!row) return c.json({ code: 'NOT_FOUND', message: 'project not found' }, 404);
    const config = readAssistantWeekly(row.agentConfig);
    if (!config)
      throw refuseAssistant(
        'ASSISTANT_WEEKLY_OFF',
        'assistantWeekly is not enabled on this project; save it on PATCH /api/projects/:id with enabled, pinnedIssue, judgeProviderId and judgeModel first',
      );
    const outcome = await runAssistantWeeklyForProject(
      { projectId: row.id, slug: row.slug, config },
      realDeps(),
      new Date(),
    );
    return c.json(outcome);
  },
);
