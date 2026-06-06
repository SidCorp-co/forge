import { zValidator } from '@hono/zod-validator';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { projectMembers, projects, skills } from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { globalEffectiveMd } from './effective.js';
import { SkillAlreadyShadowedError, applyGlobalSkillDefault } from './service.js';

/**
 * Skill Studio listing + apply-default (ISS-388). Global skills are immutable
 * read-only templates; the only per-project customization is a same-name
 * project skill that SHADOWS the global. This surface lists BOTH (non-deduped)
 * so the UI can show default(read-only) vs project(editable) + the shadow
 * relation, and exposes apply-default which copies a global template into a new
 * project skill. There is NO route that mutates a global skill.
 */

const projectParamSchema = z.object({ projectId: z.uuid() });

const applyDefaultBodySchema = z.object({ globalSkillId: z.uuid() }).strict();

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

export const skillStudioRoutes = new Hono<{ Variables: AuthVars }>();
skillStudioRoutes.use('/:projectId/skills/effective', requireAuth(), assertEmailVerified());
skillStudioRoutes.use('/:projectId/skills/apply-default', requireAuth(), assertEmailVerified());

// Effective listing for Skill Studio — globals (read-only templates) + this
// project's project skills, NOT deduped. Each row is annotated:
//   - `editable`: project skills are editable, globals are not.
//   - project skill → `shadowsGlobal` + `shadowedGlobalSkillId` (the same-name
//     global it shadows, or null).
//   - global → `shadowedByProjectSkillId` (the same-name project skill that
//     shadows it for this project, or null).
// Globals serve `globalEffectiveMd` as `skillMd` so a legacy prompt-only skill
// never surfaces a blank body.
skillStudioRoutes.get(
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

    const projectSkills = await db
      .select()
      .from(skills)
      .where(and(eq(skills.scope, 'project'), eq(skills.projectId, projectId)))
      .orderBy(asc(skills.name));

    const globalByName = new Map(globals.map((g) => [g.name, g]));
    const projectByName = new Map(projectSkills.map((p) => [p.name, p]));

    const globalRows = globals.map((g) => ({
      ...g,
      skillMd: globalEffectiveMd(g),
      editable: false as const,
      shadowsGlobal: false as const,
      shadowedGlobalSkillId: null,
      shadowedByProjectSkillId: projectByName.get(g.name)?.id ?? null,
    }));

    const projectRows = projectSkills.map((p) => {
      const shadowed = globalByName.get(p.name);
      return {
        ...p,
        editable: true as const,
        shadowsGlobal: shadowed != null,
        shadowedGlobalSkillId: shadowed?.id ?? null,
        shadowedByProjectSkillId: null,
      };
    });

    return c.json([...globalRows, ...projectRows]);
  },
);

// Apply default — copy a global template into a new same-name project skill
// (the project skill then shadows the global). Owner/admin only. Rejects when a
// same-name project skill already exists (one shadow per name).
skillStudioRoutes.post(
  '/:projectId/skills/apply-default',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', applyDefaultBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { globalSkillId } = c.req.valid('json');
    const userId = c.get('userId');

    const ctx = await loadCallerRole(projectId, userId);
    if (!isOwnerOrAdmin(ctx, userId)) {
      throw forbidden('only project owner or admin can apply a default skill');
    }

    const [global] = await db.select().from(skills).where(eq(skills.id, globalSkillId)).limit(1);
    if (!global) throw notFound('skill not found');
    if (global.scope !== 'global') {
      throw badRequest({ globalSkillId: 'apply-default source must be a global skill' });
    }

    try {
      const created = await applyGlobalSkillDefault({ projectId, global });
      return c.json(created, 201);
    } catch (err) {
      if (err instanceof SkillAlreadyShadowedError) {
        throw new HTTPException(400, {
          message: err.message,
          cause: { code: 'ALREADY_SHADOWED' },
        });
      }
      throw err;
    }
  },
);
