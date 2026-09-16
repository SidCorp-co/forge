/**
 * ISS-1056 — the one door that runs a project's weekly reading NOW: an org owner or admin who
 * flipped the toggle sees the first report without waiting for the 04:00 UTC tick. It runs the
 * same `runAssistantWeeklyForProject` the cron does, for this project only, under the same window
 * and the same already-posted check — so pressing it twice posts once.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { assertOrgRoleOnProject, loadProjectAccess } from '../../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { readAssistantWeekly } from './config.js';
import { realDeps, runAssistantWeeklyForProject } from './run.js';

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

// cm:why a router of its own, mounted at `/api/projects` from `index.ts` beside `gitCredentialRoutes` and NOT under `projectRoutes`: that file already coordinates six modules and the archmap contract refuses a seventh; so this one carries its own auth pair, the same two `projectRoutes` applies
export const assistantWeeklyRoutes = new Hono<{ Variables: AuthVars }>();
assistantWeeklyRoutes.use('*', requireAuth(), assertEmailVerified());

assistantWeeklyRoutes.post(
  '/:id/assistant-weekly/run',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const access = await loadProjectAccess(id, c.get('userId'));
    assertOrgRoleOnProject(access, 'admin', 'org admin required');
    const [row] = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        createdBy: projects.createdBy,
        agentConfig: projects.agentConfig,
      })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    if (!row)
      throw new HTTPException(404, { message: 'project not found', cause: { code: 'NOT_FOUND' } });
    const config = readAssistantWeekly(row.agentConfig);
    if (!config)
      throw new HTTPException(409, {
        message:
          'pipelineConfig.assistantWeekly is not enabled on this project; save it with enabled, pinnedIssue, judgeProviderId and judgeModel first',
        cause: { code: 'ASSISTANT_WEEKLY_OFF' },
      });
    if (!row.createdBy)
      throw new HTTPException(409, {
        message: 'the project has no creator to post the reading as',
        cause: { code: 'ASSISTANT_WEEKLY_NO_AUTHOR' },
      });
    const outcome = await runAssistantWeeklyForProject(
      { projectId: row.id, slug: row.slug, createdBy: row.createdBy, config },
      realDeps(),
      new Date(),
    );
    return c.json(outcome);
  },
);
