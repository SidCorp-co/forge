import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { badRequest, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { loadDeviceSkillStatus, resolveRegisteredEffectiveSkills } from '../skills/effective.js';
import { assertDeviceBoundToProject } from './device-project.js';
import { applySkillReport, recordSkillSyncFailure } from './service.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';

// Skill Studio 4 (ISS-278) — server-driven device skill sync.
//
// Device-token endpoints let the Rust runner pull the effective (post-shadow)
// skill manifest for a project, fetch only the skills whose hash changed, and
// report back the `installedHash` it seeded onto disk. A user-authed read
// endpoint exposes the per-device synced/outdated/missing status for the web UI
// (Skill Studio 5).

const unauth = () =>
  new HTTPException(401, { message: 'unauthenticated', cause: { code: 'UNAUTHENTICATED' } });

const projectQuerySchema = z.object({
  projectId: z.uuid(),
  includeFiles: z.string().optional(),
});

const contentQuerySchema = z.object({ projectId: z.uuid() });

const contentParamSchema = z.object({ skillId: z.uuid() });

const reportBodySchema = z
  .object({
    skills: z
      .array(
        z
          .object({
            skillId: z.uuid(),
            installedHash: z.string().min(1).max(128),
            installedVersion: z.number().int().nonnegative().optional(),
            observedSha: z.string().min(1).max(128).optional(),
            shadowedBy: z.string().max(1024).optional(),
          })
          .strict(),
      )
      .max(500),
    pruned: z.array(z.string().min(1).max(128)).max(500).optional(),
  })
  .strict();

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

export const deviceSkillRoutes = new Hono<{ Variables: DeviceVars }>();

deviceSkillRoutes.get(
  '/me/skills',
  requireDevice(),
  zValidator('query', projectQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const device = c.get('device');
    if (device.status === 'revoked') throw unauth();
    const { projectId, includeFiles } = c.req.valid('query');
    await assertDeviceBoundToProject(device.id, projectId);

    const entries = await resolveRegisteredEffectiveSkills(projectId);
    const withFiles = truthy(includeFiles);

    const skills = entries.map((e) =>
      withFiles
        ? {
            skillId: e.skillId,
            name: e.name,
            version: e.version,
            effectiveHash: e.effectiveHash,
            skillMd: e.skillMd,
            files: e.files,
          }
        : {
            skillId: e.skillId,
            name: e.name,
            version: e.version,
            effectiveHash: e.effectiveHash,
          },
    );

    return c.json({ skills });
  },
);

// GET /api/devices/me/skills/:skillId/content?projectId=
// Full body for one skill (the per-skill fetch path). 404 if the skill is not
// registered to the project.
deviceSkillRoutes.get(
  '/me/skills/:skillId/content',
  requireDevice(),
  zValidator('param', contentParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', contentQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const device = c.get('device');
    if (device.status === 'revoked') throw unauth();
    const { skillId } = c.req.valid('param');
    const { projectId } = c.req.valid('query');
    await assertDeviceBoundToProject(device.id, projectId);

    const entries = await resolveRegisteredEffectiveSkills(projectId);
    const entry = entries.find((e) => e.skillId === skillId);
    if (!entry) throw notFound('skill not registered to project');

    return c.json({
      skillId: entry.skillId,
      name: entry.name,
      version: entry.version,
      effectiveHash: entry.effectiveHash,
      skillMd: entry.skillMd,
      files: entry.files,
    });
  },
);

// POST /api/devices/me/skills/report?projectId=
// Upsert the device's installed skill hashes after it seeds them onto disk.
deviceSkillRoutes.post(
  '/me/skills/report',
  requireDevice(),
  zValidator('query', contentQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', reportBodySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const device = c.get('device');
    if (device.status === 'revoked') throw unauth();
    const { projectId } = c.req.valid('query');
    const { skills: reported, pruned } = c.req.valid('json');
    await assertDeviceBoundToProject(device.id, projectId);

    await applySkillReport({ projectId, deviceId: device.id, reported, pruned: pruned ?? [] });

    return c.json({ upserted: reported.length, pruned: pruned?.length ?? 0 });
  },
);

const syncFailedBodySchema = z.object({ error: z.string().min(1).max(2000) }).strict();

deviceSkillRoutes.post(
  '/me/skills/sync-failed',
  requireDevice(),
  zValidator('query', contentQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', syncFailedBodySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const device = c.get('device');
    if (device.status === 'revoked') throw unauth();
    const { projectId } = c.req.valid('query');
    const { error } = c.req.valid('json');
    await assertDeviceBoundToProject(device.id, projectId);

    await recordSkillSyncFailure({ projectId, deviceId: device.id, error });

    return c.json({ ok: true });
  },
);

export const deviceSkillStatusRoutes = new Hono<{ Variables: AuthVars }>();

const statusParamSchema = z.object({ projectId: z.uuid(), deviceId: z.uuid() });

deviceSkillStatusRoutes.get(
  '/:projectId/devices/:deviceId/skills',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', statusParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId, deviceId } = c.req.valid('param');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.read', projectResource(projectId));

    const status = await loadDeviceSkillStatus(projectId, deviceId);
    return c.json({ skills: status });
  },
);

// NOTE: the skill-major freshness aggregation (`loadProjectSkillSyncStatus`,
// ISS-279) is consumed by smoke-verify only, so no GET route is exposed here.
