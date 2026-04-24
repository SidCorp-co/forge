import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  issueStatuses,
  projectMembers,
  projects,
  skillRegistrations,
  skills,
} from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { hooks } from '../pipeline/hooks.js';
import { computeSkillDiff } from './sync.js';

const projectParamSchema = z.object({ projectId: z.uuid() });
const skillParamSchema = z.object({ projectId: z.uuid(), skillId: z.uuid() });

const syncManifestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2000).optional(),
  prompt: z.string().min(1),
  tools: z.array(z.string()).default([]),
  version: z.string().max(32).optional(),
  hash: z.string().min(8).max(128),
});

const syncBodySchema = z
  .object({
    mode: z.enum(['partial', 'full']).default('partial'),
    skills: z.array(syncManifestSchema).min(0).max(500),
  })
  .refine((b) => new Set(b.skills.map((s) => s.name)).size === b.skills.length, {
    message: 'duplicate skill names in payload',
  });

const registerBodySchema = z.object({
  stage: z.enum(issueStatuses).nullable(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

const notFound = (code = 'NOT_FOUND', message = 'not found') =>
  new HTTPException(404, { message, cause: { code } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

async function loadCallerRole(
  projectId: string,
  userId: string,
): Promise<{ ownerId: string; role: string | null } | null> {
  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;

  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);

  return { ownerId: project.ownerId, role: member?.role ?? null };
}

async function loadDeviceProjectRole(
  deviceOwnerId: string,
  projectId: string,
): Promise<{ isOwnerOrAdmin: boolean }> {
  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound('NOT_FOUND', 'project not found');

  if (project.ownerId === deviceOwnerId) return { isOwnerOrAdmin: true };

  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, deviceOwnerId)))
    .limit(1);
  if (!member) throw forbidden('device owner is not a project member');
  return { isOwnerOrAdmin: member.role === 'owner' || member.role === 'admin' };
}

export const skillSyncRoutes = new Hono<{ Variables: DeviceVars }>();
skillSyncRoutes.use('/:projectId/skills/sync', requireDevice());
skillSyncRoutes.post(
  '/:projectId/skills/sync',
  zValidator('param', projectParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', syncBodySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    const device = c.get('device');

    const { isOwnerOrAdmin } = await loadDeviceProjectRole(device.ownerId, projectId);
    if (body.mode === 'full' && !isOwnerOrAdmin) {
      throw forbidden("mode 'full' requires owner or admin device");
    }

    // Single SERIALIZABLE transaction: read existing inside the tx, categorise,
    // then upsert. Concurrent writers either see the same baseline and both
    // arrive at the same result, or the second serialises behind the first.
    // Unique index (project_id, name) WHERE scope='project' also guards
    // insert-race by collapsing to UPDATE via ON CONFLICT.
    const { diff, added, updated } = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ name: skills.name, contentHash: skills.contentHash })
        .from(skills)
        .where(and(eq(skills.projectId, projectId), eq(skills.scope, 'project')));

      const d = computeSkillDiff(existing, body.skills, body.mode);

      // Insert + update in one upsert. `toInsert` and `toUpdate` are both
      // project-scoped rows on (projectId, name); the partial-unique index is
      // the conflict target.
      const writes = [...d.toInsert, ...d.toUpdate];
      if (writes.length > 0) {
        await tx
          .insert(skills)
          .values(
            writes.map((m) => ({
              name: m.name,
              description: m.description ?? '',
              scope: 'project' as const,
              projectId,
              prompt: m.prompt,
              tools: m.tools,
              manifest: {},
              source: 'user' as const,
              contentHash: m.hash,
            })),
          )
          .onConflictDoUpdate({
            target: [skills.projectId, skills.name],
            targetWhere: sql`scope = 'project'`,
            // Only change fields the caller actually supplied; preserve prior
            // description if the incoming manifest omits it.
            set: {
              prompt: sql`excluded.prompt`,
              tools: sql`excluded.tools`,
              contentHash: sql`excluded.content_hash`,
              description: sql`CASE WHEN excluded.description = '' THEN ${skills.description} ELSE excluded.description END`,
              version: sql`${skills.version} + 1`,
              updatedAt: sql`now()`,
            },
          });
      }

      if (d.toRemove.length > 0) {
        await tx
          .delete(skills)
          .where(
            and(
              eq(skills.projectId, projectId),
              eq(skills.scope, 'project'),
              inArray(skills.name, d.toRemove),
            ),
          );
      }

      return {
        diff: d,
        added: d.toInsert.map((m) => m.name),
        updated: d.toUpdate.map((m) => m.name),
      };
    });

    await hooks.emit('skillSynced', {
      projectId,
      deviceId: device.id,
      added,
      updated,
      unchanged: diff.unchanged,
      removed: diff.toRemove,
    });

    return c.json({ added, updated, unchanged: diff.unchanged, removed: diff.toRemove });
  },
);

export const skillRegisterRoutes = new Hono<{ Variables: AuthVars }>();
skillRegisterRoutes.use(
  '/:projectId/skills/:skillId/register',
  requireAuth(),
  assertEmailVerified(),
);
skillRegisterRoutes.post(
  '/:projectId/skills/:skillId/register',
  zValidator('param', skillParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', registerBodySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { projectId, skillId } = c.req.valid('param');
    const { stage } = c.req.valid('json');
    const userId = c.get('userId');

    const ctx = await loadCallerRole(projectId, userId);
    if (!ctx) throw notFound('NOT_FOUND', 'project not found');

    const isOwner = ctx.role === 'owner' || ctx.ownerId === userId;
    const isAdmin = ctx.role === 'admin';
    if (!isOwner && !isAdmin) throw forbidden('requires owner or admin');

    // Skill must exist AND be either global or scoped to this project.
    const [skill] = await db
      .select({ id: skills.id, scope: skills.scope, projectId: skills.projectId })
      .from(skills)
      .where(eq(skills.id, skillId))
      .limit(1);
    if (!skill) throw notFound('NOT_FOUND', 'skill not found');
    if (skill.scope === 'project' && skill.projectId !== projectId) {
      throw notFound('NOT_FOUND', 'skill not found');
    }

    if (stage === null) {
      await db
        .delete(skillRegistrations)
        .where(
          and(eq(skillRegistrations.projectId, projectId), eq(skillRegistrations.skillId, skillId)),
        );
      void hooks.emit('skillRegistered', {
        projectId,
        skillId,
        actorUserId: userId,
        stage: null,
      });
      return c.json({ projectId, skillId, stage: null });
    }

    // Upsert: if a registration exists at (projectId, stage), update; else insert.
    // The unique index is on (projectId, stage), so re-registering a different
    // skill to the same stage would collide. Clear any prior binding for this
    // skill in this project first, then insert on conflict update.
    await db.transaction(async (tx) => {
      await tx
        .delete(skillRegistrations)
        .where(
          and(eq(skillRegistrations.projectId, projectId), eq(skillRegistrations.skillId, skillId)),
        );
      await tx
        .insert(skillRegistrations)
        .values({ projectId, skillId, stage, registeredBy: userId })
        .onConflictDoUpdate({
          target: [skillRegistrations.projectId, skillRegistrations.stage],
          set: { skillId, registeredBy: userId },
        });
    });

    void hooks.emit('skillRegistered', { projectId, skillId, actorUserId: userId, stage });

    return c.json({ projectId, skillId, stage });
  },
);
