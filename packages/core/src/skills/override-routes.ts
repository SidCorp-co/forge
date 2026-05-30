import { zValidator } from '@hono/zod-validator';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { projectMembers, projectSkillOverrides, projects, skills } from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { globalEffectiveHash, globalEffectiveMd } from './effective.js';
import { hashSkillBody } from './hash.js';

const overrideParamSchema = z.object({
  projectId: z.uuid(),
  skillId: z.uuid(),
});

const projectParamSchema = z.object({ projectId: z.uuid() });

// A single forked file. Mirrors `SkillFile` (effective.ts) — base64 lets the
// fork carry binary references/scripts, not just markdown.
const skillFileSchema = z
  .object({
    path: z.string().min(1).max(1024),
    content: z.string().max(5_000_000),
    encoding: z.enum(['utf8', 'base64']),
  })
  .strict();

const overrideBodySchema = z
  .object({
    skillMdOverride: z.string().min(1).max(200_000),
    // Optional: when omitted on create the whole global folder is forked as the
    // editable starting point; when omitted on update the existing files are
    // preserved.
    files: z.array(skillFileSchema).max(500).optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

async function loadCallerRole(projectId: string, userId: string) {
  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound('project not found');

  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);

  return { ownerId: project.ownerId, role: member?.role ?? null };
}

function isMember(ctx: { ownerId: string; role: string | null }, userId: string): boolean {
  return ctx.ownerId === userId || ctx.role !== null;
}

function isOwnerOrAdmin(ctx: { ownerId: string; role: string | null }, userId: string): boolean {
  return ctx.ownerId === userId || ctx.role === 'owner' || ctx.role === 'admin';
}

async function loadGlobalSkill(skillId: string) {
  const [row] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  if (!row) throw notFound('skill not found');
  if (row.scope !== 'global') {
    throw badRequest({ skillId: 'override target must be a global skill' });
  }
  return row;
}

export const skillOverrideRoutes = new Hono<{ Variables: AuthVars }>();
skillOverrideRoutes.use(
  '/:projectId/skills/effective',
  requireAuth(),
  assertEmailVerified(),
);
skillOverrideRoutes.use(
  '/:projectId/skills/:skillId/override',
  requireAuth(),
  assertEmailVerified(),
);

// Effective skill list — global skills with project overrides merged in. Each
// row carries `isOverridden` so the web Skills page can render Global vs
// Override badges and decide whether the diff-vs-global toggle is meaningful.
skillOverrideRoutes.get(
  '/:projectId/skills/effective',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const ctx = await loadCallerRole(projectId, userId);
    if (!isMember(ctx, userId)) throw forbidden('not a project member');

    const globals = await db
      .select()
      .from(skills)
      .where(eq(skills.scope, 'global'))
      .orderBy(asc(skills.name));

    const overrides = await db
      .select()
      .from(projectSkillOverrides)
      .where(eq(projectSkillOverrides.projectId, projectId))
      .orderBy(asc(projectSkillOverrides.skillId));

    const overrideBySkillId = new Map(overrides.map((o) => [o.skillId, o]));

    // The global's current effective body + hash. Legacy skills (seeded
    // pre-v0.1) only have `prompt` populated (`skillMd` NULL); the shared
    // `globalEffective*` helpers fall back to `prompt` so the device never
    // installs a 0-byte SKILL.md, and recompute the hash so a cached legacy
    // contentHash doesn't pin clients on the empty install.
    const result = globals.map((g) => {
      const globalMd = globalEffectiveMd(g);
      const currentGlobalHash = globalEffectiveHash(g);
      const ov = overrideBySkillId.get(g.id);
      if (!ov) {
        return {
          ...g,
          skillMd: globalMd,
          contentHash: currentGlobalHash,
          isOverridden: false as const,
          overrideId: null,
          globalContentHash: currentGlobalHash,
          forkedFromHash: null,
          driftFromGlobal: false,
        };
      }
      // Forked folder: serve the override's files, falling back to the base
      // global files for legacy markdown-only rows (files = []).
      const overrideFiles =
        Array.isArray(ov.files) && ov.files.length > 0 ? ov.files : g.files;
      return {
        ...g,
        skillMd: ov.skillMdOverride,
        prompt: ov.skillMdOverride,
        files: overrideFiles,
        contentHash: ov.contentHash,
        updatedAt: ov.updatedAt,
        isOverridden: true as const,
        overrideId: ov.id,
        // `globalContentHash` = the global's *current* effective hash;
        // `forkedFromHash` = the snapshot taken when the fork was created.
        // Drift is "the global moved since we forked".
        globalContentHash: currentGlobalHash,
        forkedFromHash: ov.globalContentHash ?? null,
        driftFromGlobal:
          ov.globalContentHash != null && ov.globalContentHash !== currentGlobalHash,
      };
    });

    return c.json(result);
  },
);

skillOverrideRoutes.get(
  '/:projectId/skills/:skillId/override',
  zValidator('param', overrideParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, skillId } = c.req.valid('param');
    const userId = c.get('userId');

    const ctx = await loadCallerRole(projectId, userId);
    if (!isMember(ctx, userId)) throw forbidden('not a project member');

    await loadGlobalSkill(skillId);

    const [row] = await db
      .select()
      .from(projectSkillOverrides)
      .where(
        and(
          eq(projectSkillOverrides.projectId, projectId),
          eq(projectSkillOverrides.skillId, skillId),
        ),
      )
      .limit(1);
    if (!row) throw notFound('override not found');

    return c.json(row);
  },
);

// Upsert override for (project, skill). PUT semantics: any existing row is
// replaced; otherwise a fresh row is inserted. Body carries the override
// markdown only — the content_hash is derived server-side so clients cannot
// drift.
skillOverrideRoutes.put(
  '/:projectId/skills/:skillId/override',
  zValidator('param', overrideParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', overrideBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, skillId } = c.req.valid('param');
    const { skillMdOverride, files } = c.req.valid('json');
    const userId = c.get('userId');

    const ctx = await loadCallerRole(projectId, userId);
    if (!isOwnerOrAdmin(ctx, userId)) {
      throw forbidden('only project owner or admin can update skill overrides');
    }

    const skill = await loadGlobalSkill(skillId);

    const [existing] = await db
      .select({
        id: projectSkillOverrides.id,
        files: projectSkillOverrides.files,
      })
      .from(projectSkillOverrides)
      .where(
        and(
          eq(projectSkillOverrides.projectId, projectId),
          eq(projectSkillOverrides.skillId, skillId),
        ),
      )
      .limit(1);

    let row;
    if (existing) {
      // Update: take new files when supplied, otherwise preserve the fork's
      // existing files. `globalContentHash` is left untouched (re-forking is a
      // delete + recreate). Hash always reflects the merged md + files.
      const effectiveFiles = files ?? (Array.isArray(existing.files) ? existing.files : []);
      const contentHash = hashSkillBody(skillMdOverride, effectiveFiles);
      const [updated] = await db
        .update(projectSkillOverrides)
        .set({ skillMdOverride, files: effectiveFiles, contentHash, updatedAt: new Date() })
        .where(eq(projectSkillOverrides.id, existing.id))
        .returning();
      row = updated;
    } else {
      // Create = fork the whole current global folder as the editable starting
      // point (unless the client supplied its own files), and snapshot the
      // global's effective hash so the effective view can later flag drift.
      const forkedFiles = files ?? (Array.isArray(skill.files) ? skill.files : []);
      const contentHash = hashSkillBody(skillMdOverride, forkedFiles);
      const globalContentHash = globalEffectiveHash(skill);
      const [inserted] = await db
        .insert(projectSkillOverrides)
        .values({ projectId, skillId, skillMdOverride, files: forkedFiles, contentHash, globalContentHash })
        .returning();
      row = inserted;
    }
    if (!row) throw new Error('project_skill_overrides: upsert returned no row');

    await hooks.emit('skillUpdated', {
      projectId,
      skillId,
      name: skill.name,
      action: 'upsert',
      contentHash: row.contentHash,
      actorUserId: userId,
    });

    return c.json(row);
  },
);

skillOverrideRoutes.delete(
  '/:projectId/skills/:skillId/override',
  zValidator('param', overrideParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, skillId } = c.req.valid('param');
    const userId = c.get('userId');

    const ctx = await loadCallerRole(projectId, userId);
    if (!isOwnerOrAdmin(ctx, userId)) {
      throw forbidden('only project owner or admin can delete skill overrides');
    }

    const skill = await loadGlobalSkill(skillId);

    const result = await db
      .delete(projectSkillOverrides)
      .where(
        and(
          eq(projectSkillOverrides.projectId, projectId),
          eq(projectSkillOverrides.skillId, skillId),
        ),
      )
      .returning({ id: projectSkillOverrides.id });
    if (result.length === 0) throw notFound('override not found');

    await hooks.emit('skillUpdated', {
      projectId,
      skillId,
      name: skill.name,
      action: 'delete',
      contentHash: null,
      actorUserId: userId,
    });

    return c.body(null, 204);
  },
);
