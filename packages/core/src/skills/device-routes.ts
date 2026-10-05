import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertDeviceBoundToProject } from '../devices/index.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { resolveRegisteredEffectiveSkills } from './effective.js';

// Skill Studio 4 (ISS-278) — server-driven device skill sync.
//
// Device-token endpoints let the Rust runner pull the effective (post-shadow)
// skill manifest for a project and fetch only the skills whose hash changed.

const unauth = () =>
  new HTTPException(401, { message: 'unauthenticated', cause: { code: 'UNAUTHENTICATED' } });

const projectQuerySchema = z.object({
  projectId: z.uuid(),
  includeFiles: z.string().optional(),
});

const contentQuerySchema = z.object({ projectId: z.uuid() });

const contentParamSchema = z.object({ skillId: z.uuid() });

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

export const deviceSkillRoutes = new Hono<{ Variables: DeviceVars }>();

deviceSkillRoutes.get(
  '/me/skills',
  requireDevice(),
  zValidator('query', projectQuerySchema),
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
  zValidator('param', contentParamSchema),
  zValidator('query', contentQuerySchema),
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
