import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { assertPlatformAdmin } from '../middleware/require-admin.js';
import { checkSkillActivityChainIntegrity } from './activity-chain-integrity.js';
import { listByDevice, listByPacket, listBySkill, summarizeByEventType } from './activity-views.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

/**
 * The history is capped rather than whole (ISS-1025): every one of these views
 * was an unbounded read of `skill_activity_events`, and a project that has been
 * reconciling for months answers one of them with its entire log. A caller who
 * wants more says so, up to the maximum, and every response states which cap it
 * was answered under.
 */
const DEFAULT_ACTIVITY_LIMIT = 200;
const MAX_ACTIVITY_LIMIT = 1000;

const querySchema = z.object({
  projectId: z.uuid().optional(),
  skillId: z.uuid().optional(),
  deviceId: z.uuid().optional(),
  packetId: z.string().min(1).optional(),
  // cm:guard a limit over the maximum is REFUSED and never clamped: a caller asking for 50,000 events and served 1,000 under a `truncated` flag it did not ask about reads the page as the whole log. The refusal names the maximum.
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_ACTIVITY_LIMIT, `limit must not exceed ${MAX_ACTIVITY_LIMIT}`)
    .default(DEFAULT_ACTIVITY_LIMIT),
});

export const skillActivityRoutes = new Hono<{ Variables: AuthVars }>();
skillActivityRoutes.use('*', requireAuth(), assertEmailVerified());

/**
 * The three §7 views over the skill-update activity log, selected by which
 * filter is present: `packetId` -> by-packet (cross-project operational
 * rollup, admin-only since one packet spans every adopting project),
 * `projectId` + `deviceId` -> by-device, `projectId` (+ optional `skillId`)
 * -> by-skill.
 */
skillActivityRoutes.get('/', async (c) => {
  const parsed = querySchema.safeParse({
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
    return c.json({
      view: 'by-packet',
      packetId,
      events,
      limit,
      truncated,
      summary: await summarizeByEventType(packetId),
    });
  }

  if (!projectId) {
    throw badRequest('one of projectId, deviceId (with projectId), or packetId is required');
  }
  const access = await loadProjectAccess(projectId, c.get('userId'));
  if (!access.role) throw forbidden('not a project member');

  if (deviceId) {
    const { events, truncated } = await listByDevice({ projectId, deviceId, limit });
    return c.json({ view: 'by-device', projectId, deviceId, events, limit, truncated });
  }

  const { events, truncated } = await listBySkill(
    skillId ? { projectId, skillId, limit } : { projectId, limit },
  );
  return c.json({
    view: 'by-skill',
    projectId,
    skillId: skillId ?? null,
    events,
    limit,
    truncated,
  });
});

// cm:why the §7 self-check (activity-chain-integrity.ts) had no operational surface before this — only an integration test called it, so a broken chain in production went undetected (ISS-798 fix review).
skillActivityRoutes.get('/chain-integrity', async (c) => {
  await assertPlatformAdmin(c);
  const report = await checkSkillActivityChainIntegrity();
  return c.json(report);
});
