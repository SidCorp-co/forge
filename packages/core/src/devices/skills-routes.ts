import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { deviceSkills, runners, skills } from '../db/schema.js';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { recordSkillActivityEvent } from '../skills/activity.js';
import { loadDeviceSkillStatus, resolveRegisteredEffectiveSkills } from '../skills/effective.js';

// Skill Studio 4 (ISS-278) — server-driven device skill sync.
//
// Device-token endpoints let the Rust runner pull the effective (post-shadow)
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
            // cm:why both absent on pre-0.7.0 runners — server treats a null observedSha as `unknown`, never `synced`
            observedSha: z.string().min(1).max(128).optional(),
            shadowedBy: z.string().max(1024).optional(),
          })
          .strict(),
      )
      .max(500),
    // cm:why NAMES, not ids — the runner has no id for a manifest entry that no longer exists
    pruned: z.array(z.string().min(1).max(128)).max(500).optional(),
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
    const { skills: reported, pruned } = c.req.valid('json');
    await assertDeviceBoundToProject(device.id, projectId);

    const now = new Date();
    for (const s of reported) {
      await applyReportedSkill({ projectId, deviceId: device.id, syncedAt: now, entry: s });
    }

    for (const name of pruned ?? []) {
      await recordPrunedSkill({ projectId, deviceId: device.id, name });
    }

    return c.json({ upserted: reported.length, pruned: pruned?.length ?? 0 });
  },
);

const syncFailedBodySchema = z.object({ error: z.string().min(1).max(2000) }).strict();

// cm:why separate from /report — a manifest/content pull failure has no installed skills to report, so the success schema doesn't fit.
deviceSkillRoutes.post(
  '/me/skills/sync-failed',
  requireDevice(),
  zValidator('query', contentQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', syncFailedBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const device = c.get('device');
    if (device.status === 'revoked') throw unauth();
    const { projectId } = c.req.valid('query');
    const { error } = c.req.valid('json');
    await assertDeviceBoundToProject(device.id, projectId);

    await recordSkillActivityEvent(db, {
      eventType: 'device.sync.failed',
      actor: `runner:${device.id}`,
      trigger: 'poll',
      projectId,
      deviceId: device.id,
      reason: error,
      outcome: 'failed',
    });

    return c.json({ ok: true });
  },
);

/**
 * Upsert one device_skills row and emit the state-transition events it
 * causes, all in one transaction (§9.11). A no-op poll (nothing changed vs
 * the prior row) emits nothing — §7 principle 1: log transitions, not
 * checks. `shadowedBy` set is treated as the alert case (`device.skill.shadowed`);
 * `device.skill.observed` only fires for the normal unshadowed path, so the
 * two never double-fire for the same report.
 */
async function applyReportedSkill(input: {
  projectId: string;
  deviceId: string;
  syncedAt: Date;
  entry: {
    skillId: string;
    installedHash: string;
    installedVersion?: number | undefined;
    observedSha?: string | undefined;
    shadowedBy?: string | undefined;
  };
}): Promise<void> {
  const { projectId, deviceId, syncedAt, entry } = input;
  const nextObservedSha = entry.observedSha ?? null;
  const nextShadowedBy = entry.shadowedBy ?? null;

  const [existing] = await db
    .select({
      installedHash: deviceSkills.installedHash,
      observedSha: deviceSkills.observedSha,
      shadowedBy: deviceSkills.shadowedBy,
    })
    .from(deviceSkills)
    .where(
      and(
        eq(deviceSkills.deviceId, deviceId),
        eq(deviceSkills.projectId, projectId),
        eq(deviceSkills.skillId, entry.skillId),
      ),
    )
    .limit(1);

  const hashChanged = !existing || existing.installedHash !== entry.installedHash;
  const observedChanged = existing
    ? existing.observedSha !== nextObservedSha
    : nextObservedSha !== null;
  const shadowChanged = existing ? existing.shadowedBy !== nextShadowedBy : nextShadowedBy !== null;

  await db.transaction(async (tx) => {
    await tx
      .insert(deviceSkills)
      .values({
        deviceId,
        projectId,
        skillId: entry.skillId,
        installedHash: entry.installedHash,
        installedVersion: entry.installedVersion ?? null,
        syncedAt,
        observedSha: nextObservedSha,
        shadowedBy: nextShadowedBy,
      })
      .onConflictDoUpdate({
        target: [deviceSkills.deviceId, deviceSkills.projectId, deviceSkills.skillId],
        set: {
          installedHash: entry.installedHash,
          installedVersion: entry.installedVersion ?? null,
          syncedAt,
          observedSha: nextObservedSha,
          shadowedBy: nextShadowedBy,
        },
      });

    if (hashChanged) {
      await recordSkillActivityEvent(tx, {
        eventType: 'device.skill.applied',
        actor: `runner:${deviceId}`,
        trigger: 'poll',
        projectId,
        skillId: entry.skillId,
        deviceId,
        ...(existing?.installedHash !== undefined ? { beforeHash: existing.installedHash } : {}),
        afterHash: entry.installedHash,
        outcome: 'ok',
      });
    }

    if (nextShadowedBy !== null) {
      if (shadowChanged || observedChanged) {
        await recordSkillActivityEvent(tx, {
          eventType: 'device.skill.shadowed',
          actor: `runner:${deviceId}`,
          trigger: 'poll',
          projectId,
          skillId: entry.skillId,
          deviceId,
          ...(existing?.observedSha ? { beforeHash: existing.observedSha } : {}),
          ...(nextObservedSha !== null ? { afterHash: nextObservedSha } : {}),
          deltaSummary: nextShadowedBy,
          outcome: 'ok',
        });
      }
    } else if (observedChanged) {
      await recordSkillActivityEvent(tx, {
        eventType: 'device.skill.observed',
        actor: `runner:${deviceId}`,
        trigger: 'poll',
        projectId,
        skillId: entry.skillId,
        deviceId,
        ...(existing?.observedSha ? { beforeHash: existing.observedSha } : {}),
        ...(nextObservedSha !== null ? { afterHash: nextObservedSha } : {}),
        outcome: 'ok',
      });
    }
  });
}

/**
 * A pruned skill is reported by NAME (the runner has no id for a manifest
 * entry that no longer exists) — resolve it to the project's skill row so the
 * activity event and the stale device_skills row are keyed correctly. Removes
 * the device_skills row (it no longer reflects disk) and the event, in the
 * SAME transaction (§9.11). Best-effort: an unresolvable name (skill deleted
 * entirely, not just unregistered) still gets an event with a null skillId.
 */
async function recordPrunedSkill(input: {
  projectId: string;
  deviceId: string;
  name: string;
}): Promise<void> {
  const [skill] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.scope, 'project'),
        eq(skills.projectId, input.projectId),
        eq(skills.name, input.name),
      ),
    )
    .limit(1);

  await db.transaction(async (tx) => {
    if (skill) {
      await tx
        .delete(deviceSkills)
        .where(
          and(
            eq(deviceSkills.deviceId, input.deviceId),
            eq(deviceSkills.projectId, input.projectId),
            eq(deviceSkills.skillId, skill.id),
          ),
        );
    }
    await recordSkillActivityEvent(tx, {
      eventType: 'device.skill.pruned',
      actor: `runner:${input.deviceId}`,
      trigger: 'poll',
      projectId: input.projectId,
      ...(skill ? { skillId: skill.id } : {}),
      deviceId: input.deviceId,
      deltaSummary: input.name,
      outcome: 'ok',
    });
  });
}

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

// NOTE: the skill-major freshness aggregation (`loadProjectSkillSyncStatus`,
// ISS-279) is served over MCP (`forge_skills.sync_status`) and consumed by
// smoke-verify — it never had a REST wrapper with a client, so no GET route is
// exposed here. Add one back if a web Studio by-skill panel ever needs it.
