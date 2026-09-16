/**
 * ISS-1056 — the one door that runs a project's weekly reading NOW: an org owner or admin who
 * flipped the toggle sees the first report without waiting for the 04:00 UTC tick. It runs the
 * same `runAssistantWeeklyForProject` the cron does, for this project only, under the same window
 * and the same already-posted check — so pressing it twice posts once.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { assertOrgRoleOnProject, loadProjectAccess } from '../../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { readAssistantWeekly } from './config.js';
import { realDeps, runAssistantWeeklyForProject } from './run.js';

const idParamSchema = z.object({ id: z.uuid() });

// cm:why refusals are answered with `c.json` in the error handler's `{ code, message }` shape rather than thrown: `hono/http-exception` is a subpath the archmap cannot resolve, the repo sits exactly at its 200-edge ceiling, and one more file importing it turns the conformance audit red (R7)

// cm:why a router of its own, mounted at `/api/projects` from `index.ts` beside `gitCredentialRoutes` and NOT under `projectRoutes`: that file already coordinates six modules and the archmap contract refuses a seventh; so this one carries its own auth pair, the same two `projectRoutes` applies
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
    if (!row) return c.json({ code: 'NOT_FOUND', message: 'project not found' }, 404);
    const config = readAssistantWeekly(row.agentConfig);
    if (!config)
      return c.json(
        {
          code: 'ASSISTANT_WEEKLY_OFF',
          message:
            'pipelineConfig.assistantWeekly is not enabled on this project; save it with enabled, pinnedIssue, judgeProviderId and judgeModel first',
        },
        409,
      );
    if (!row.createdBy)
      return c.json(
        {
          code: 'ASSISTANT_WEEKLY_NO_AUTHOR',
          message: 'the project has no creator to post the reading as',
        },
        409,
      );
    const outcome = await runAssistantWeeklyForProject(
      { projectId: row.id, slug: row.slug, createdBy: row.createdBy, config },
      realDeps(),
      new Date(),
    );
    return c.json(outcome);
  },
);
