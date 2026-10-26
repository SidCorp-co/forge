/**
 * ISS-1056 — the one door that runs a project's weekly reading NOW: an org owner or admin who
 * flipped the toggle sees the first report without waiting for the 04:00 UTC tick. It runs the
 * same `runAssistantWeeklyForProject` the cron does, for this project only, under the same window
 * and the same already-posted check — so pressing it twice posts once.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../../api-reference/declare/describe.js';
import { zValidator } from '../../api-reference/declare/validator.js';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { assertOrgRoleOnProject, loadProjectAccess } from '../../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { readAssistantWeekly } from './config.js';
import { runAssistantWeekly, weeklyOutcomeSchema } from './routes-reference.js';
import { realDeps, runAssistantWeeklyForProject } from './run.js';

const idParamSchema = z.object({ id: z.uuid() });

export const assistantWeeklyRoutes = new Hono<{ Variables: AuthVars }>();
assistantWeeklyRoutes.use('*', requireAuth(), assertEmailVerified());

assistantWeeklyRoutes.post(
  '/:id/assistant-weekly/run',
  runAssistantWeekly,
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
    assertOrgRoleOnProject(access, 'admin', 'run its weekly assistant digest');
    const [row] = await db
      .select({
        id: projects.id,
        slug: projects.slug,
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
          'The weekly reading is not enabled on this project. Save pipelineConfig.assistantWeekly with enabled, pinnedIssue, judgeProviderId and judgeModel first.',
        cause: { code: 'ASSISTANT_WEEKLY_OFF' },
      });
    const outcome = await runAssistantWeeklyForProject(
      { projectId: row.id, slug: row.slug, config },
      realDeps(),
      new Date(),
    );
    return c.json(answer(weeklyOutcomeSchema, outcome));
  },
);
