import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { deviceSkills, runners } from '../db/schema.js';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import {
  loadDeviceSkillStatus,
  loadProjectSkillSyncStatus,
  resolveRegisteredEffectiveSkills,
} from '../skills/effective.js';

// Skill Studio 4 (ISS-278) — server-driven device skill sync.
//
// Device-token endpoints let the Rust runner pull the effective (post-override)
// skill manifest for a project, fetch only the skills whose hash changed, and
// report back the `installedHash` it seeded onto disk. A user-authed read
// endpoint exposes the per-device synced/outdated/missing status for the web UI
// (Skill Studio 5).

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const unauth = () =>
  new HTTPException(401, { message: 'unauthenticated', cause: { code: 'UNAUTHENTICATED' } });

/**
 * Device↔project binding gate. A device may only pull/report skills for a
 * project it is a `claude-code` runner for. No binding → 403 (prevents
 * cross-project skill leakage). The `requireDevice` middleware already 401s on
 * a missing/invalid/revoked token before this runs.
 */
async function assertDeviceBoundToProject(deviceId: string, projectId: string): Promise<void> {
  const [row] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(
      and(
        eq(runners.deviceId, deviceId),
        eq(runners.projectId, projectId),
        eq(runners.type, 'claude-code'),
      ),
    )
    .limit(1);
  if (!row) throw forbidden('device not bound to project');
}

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
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

// ── Device-token routes (mounted under /api/devices) ────────────────────────
export const deviceSkillRoutes = new Hono<{ Variables: DeviceVars }>();

// GET /api/devices/me/skills?projectId=&includeFiles=1
// Lightweight manifest by default (hashes only) so the runner can diff against
// its local cache and fetch only changed skills. `?includeFiles=1` returns the
// full bodies in one shot (used for a cold cache / convenience).
deviceSkillRoutes.get(
  '/me/skills',
  requireDevice(),
  zValidator('query', projectQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
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
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', contentQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
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
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', reportBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const device = c.get('device');
    if (device.status === 'revoked') throw unauth();
    const { projectId } = c.req.valid('query');
    const { skills } = c.req.valid('json');
    await assertDeviceBoundToProject(device.id, projectId);

    const now = new Date();
    for (const s of skills) {
      await db
        .insert(deviceSkills)
        .values({
          deviceId: device.id,
          projectId,
          skillId: s.skillId,
          installedHash: s.installedHash,
          installedVersion: s.installedVersion ?? null,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: [deviceSkills.deviceId, deviceSkills.projectId, deviceSkills.skillId],
          set: {
            installedHash: s.installedHash,
            installedVersion: s.installedVersion ?? null,
            syncedAt: now,
          },
        });
    }

    return c.json({ upserted: skills.length });
  },
);

// ── User-token route (mounted under /api/projects) ──────────────────────────
// GET /api/projects/:projectId/devices/:deviceId/skills
// Per-device synced/outdated/missing status for the web UI (Skill Studio 5).
export const deviceSkillStatusRoutes = new Hono<{ Variables: AuthVars }>();

const statusParamSchema = z.object({ projectId: z.uuid(), deviceId: z.uuid() });

deviceSkillStatusRoutes.get(
  '/:projectId/devices/:deviceId/skills',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', statusParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, deviceId } = c.req.valid('param');
    const userId = c.get('userId');
    await assertProjectAccess(projectId, userId, 'viewer');

    const status = await loadDeviceSkillStatus(projectId, deviceId);
    return c.json({ skills: status });
  },
);

const syncStatusParamSchema = z.object({ projectId: z.uuid() });

// GET /api/projects/:projectId/skill-sync-status
// Aggregated skill-major freshness for the Studio by-skill panel (ISS-279):
// every project-bound device × every registered skill, sourced from the real
// `device_skills` rows. Replaces the legacy empty-`devices` stub.
deviceSkillStatusRoutes.get(
  '/:projectId/skill-sync-status',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', syncStatusParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    await assertProjectAccess(projectId, userId, 'viewer');

    const data = await loadProjectSkillSyncStatus(projectId);
    return c.json(data);
  },
);
