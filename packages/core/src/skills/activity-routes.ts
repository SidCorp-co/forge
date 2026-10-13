import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/describe.js';
import { declaresInput } from '../api-reference/validator.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { assertPlatformAdmin } from '../middleware/require-admin.js';
import { checkSkillActivityChainIntegrity } from './activity-chain-integrity.js';
import {
  activityQuerySchema,
  activitySchema,
  chainIntegritySchema,
  readSkillActivity,
  readSkillActivityChainIntegrity,
} from './activity-routes-reference.js';
import { listByDevice, listByPacket, listBySkill, summarizeByEventType } from './activity-views.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const skillActivityRoutes = new Hono<{ Variables: AuthVars }>();
skillActivityRoutes.use('*', requireAuth(), assertEmailVerified());

/**
 * The three §7 views over the skill-update activity log, selected by which
 * filter is present: `packetId` -> by-packet (cross-project operational
 * rollup, admin-only since one packet spans every adopting project),
 * `projectId` + `deviceId` -> by-device, `projectId` (+ optional `skillId`)
 * -> by-skill.
 */
skillActivityRoutes.get(
  '/',
  readSkillActivity,
  declaresInput('query', activityQuerySchema),
  async (c) => {
    const parsed = activityQuerySchema.safeParse({
      projectId: c.req.query('projectId'),
      skillId: c.req.query('skillId'),
      deviceId: c.req.query('deviceId'),
      packetId: c.req.query('packetId'),
      limit: c.req.query('limit'),
    });
    if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
    const { projectId, skillId, deviceId, packetId, limit } = parsed.data;

    if (packetId) {
      await assertPlatformAdmin(c);
      const { events, truncated } = await listByPacket(packetId, limit);
      return c.json(
        answer(activitySchema, {
          view: 'by-packet',
          packetId,
          events,
          limit,
          truncated,
          summary: await summarizeByEventType(packetId),
        }),
      );
    }

    if (!projectId) {
      throw badRequest('one of projectId, deviceId (with projectId), or packetId is required');
    }
    const access = await loadProjectAccess(projectId, c.get('userId'));
    if (!access.role) throw forbidden('not a project member');

    if (deviceId) {
      const { events, truncated } = await listByDevice({ projectId, deviceId, limit });
      return c.json(
        answer(activitySchema, {
          view: 'by-device',
          projectId,
          deviceId,
          events,
          limit,
          truncated,
        }),
      );
    }

    const { events, truncated } = await listBySkill(
      skillId ? { projectId, skillId, limit } : { projectId, limit },
    );
    return c.json(
      answer(activitySchema, {
        view: 'by-skill',
        projectId,
        skillId: skillId ?? null,
        events,
        limit,
        truncated,
      }),
    );
  },
);

skillActivityRoutes.get('/chain-integrity', readSkillActivityChainIntegrity, async (c) => {
  await assertPlatformAdmin(c);
  const report = await checkSkillActivityChainIntegrity();
  return c.json(answer(chainIntegritySchema, report));
});
