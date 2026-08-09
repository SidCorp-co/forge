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

const querySchema = z.object({
  projectId: z.uuid().optional(),
  skillId: z.uuid().optional(),
  deviceId: z.uuid().optional(),
  packetId: z.string().min(1).optional(),
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
  });
  if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
  const { projectId, skillId, deviceId, packetId } = parsed.data;

  if (packetId) {
    await assertPlatformAdmin(c.get('userId'));
    const events = await listByPacket(packetId);
    return c.json({ view: 'by-packet', packetId, events, summary: summarizeByEventType(events) });
  }

  if (!projectId) {
    throw badRequest('one of projectId, deviceId (with projectId), or packetId is required');
  }
  const access = await loadProjectAccess(projectId, c.get('userId'));
  if (!access.role) throw forbidden('not a project member');

  if (deviceId) {
    const events = await listByDevice({ projectId, deviceId });
    return c.json({ view: 'by-device', projectId, deviceId, events });
  }

  const events = await listBySkill(skillId ? { projectId, skillId } : { projectId });
  return c.json({ view: 'by-skill', projectId, skillId: skillId ?? null, events });
});

// cm:why the §7 self-check (activity-chain-integrity.ts) had no operational surface before this — only an integration test called it, so a broken chain in production went undetected (ISS-798 fix review).
skillActivityRoutes.get('/chain-integrity', async (c) => {
  await assertPlatformAdmin(c.get('userId'));
  const report = await checkSkillActivityChainIntegrity();
  return c.json(report);
});
