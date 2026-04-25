import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import {
  jobs,
  projectMembers,
  projects,
  skillRegistrations,
  skills,
  skillTargets,
} from '../db/schema.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { logger } from '../logger.js';

const idParamSchema = z.object({ id: z.uuid() });

const fileSchema = z
  .object({
    path: z.string().min(1).max(500),
    content: z.string(),
    encoding: z.enum(['utf8', 'base64']).default('utf8'),
  })
  .strict();

const skillCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().max(2000),
    skillMd: z.string().min(1),
    target: z.enum(skillTargets).optional(),
    isGlobal: z.boolean().optional(),
    files: z.array(fileSchema).optional(),
    localGuide: z.string().max(20_000).nullable().optional(),
    projectId: z.uuid().optional(),
  })
  .strict();

const skillUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().max(2000).optional(),
    skillMd: z.string().min(1).optional(),
    target: z.enum(skillTargets).optional(),
    isGlobal: z.boolean().optional(),
    files: z.array(fileSchema).optional(),
    localGuide: z.string().max(20_000).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const listQuerySchema = z
  .object({
    projectId: z.uuid().optional(),
    scope: z.enum(['global', 'project', 'all']).optional(),
  })
  .strict();

const syncStatusSchema = z
  .object({
    projectId: z.uuid(),
  })
  .strict();

const bulkPushSchema = z
  .object({
    targets: z.array(z.string().min(1)).min(1).max(10),
    projectId: z.uuid(),
    skillNames: z.array(z.string().min(1)).optional(),
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

function hashSkillBody(skillMd: string, files: unknown): string {
  const payload = JSON.stringify({ skillMd, files: files ?? [] });
  return createHash('sha256').update(payload).digest('hex');
}

export const skillCrudRoutes = new Hono<{ Variables: AuthVars }>();
skillCrudRoutes.use('*', requireAuth(), assertEmailVerified());

skillCrudRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, scope } = c.req.valid('query');
    const userId = c.get('userId');

    const conditions: SQL[] = [];
    if (scope === 'global') {
      conditions.push(eq(skills.scope, 'global'));
    } else if (scope === 'project') {
      if (!projectId) throw badRequest({ projectId: 'required when scope=project' });
      const ctx = await loadCallerRole(projectId, userId);
      if (!ctx.role && ctx.ownerId !== userId) throw forbidden('not a project member');
      conditions.push(and(eq(skills.scope, 'project'), eq(skills.projectId, projectId)) as SQL);
    } else {
      // default + 'all': global ∪ project (if projectId)
      if (projectId) {
        const ctx = await loadCallerRole(projectId, userId);
        if (!ctx.role && ctx.ownerId !== userId) throw forbidden('not a project member');
        const projectCond = and(eq(skills.scope, 'project'), eq(skills.projectId, projectId)) as SQL;
        conditions.push(or(eq(skills.scope, 'global'), projectCond) as SQL);
      } else {
        conditions.push(eq(skills.scope, 'global'));
      }
    }

    const rows = await db
      .select()
      .from(skills)
      .where(and(...conditions))
      .orderBy(asc(skills.name));

    return c.json(rows);
  },
);

skillCrudRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
    if (!row) throw notFound('skill not found');

    if (row.scope === 'project' && row.projectId) {
      const ctx = await loadCallerRole(row.projectId, userId);
      if (!ctx.role && ctx.ownerId !== userId) throw forbidden('not a project member');
    }

    return c.json(row);
  },
);

skillCrudRoutes.post(
  '/',
  zValidator('json', skillCreateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const isGlobal = input.isGlobal ?? false;
    const scope = isGlobal ? 'global' : 'project';

    if (!isGlobal && !input.projectId) {
      throw badRequest({ projectId: 'required when isGlobal=false' });
    }

    if (input.projectId) {
      const ctx = await loadCallerRole(input.projectId, userId);
      if (ctx.ownerId !== userId && ctx.role !== 'owner' && ctx.role !== 'admin') {
        throw forbidden('only project owner or admin can create skills');
      }
    }

    const contentHash = hashSkillBody(input.skillMd, input.files);

    const [inserted] = await db
      .insert(skills)
      .values({
        name: input.name,
        description: input.description,
        scope: scope as 'global' | 'project',
        projectId: input.projectId ?? null,
        prompt: input.skillMd, // keep prompt in sync with skillMd for runtime
        tools: [],
        manifest: {},
        source: 'user',
        contentHash,
        skillMd: input.skillMd,
        target: input.target ?? null,
        files: (input.files ?? []) as never,
        localGuide: input.localGuide ?? null,
      })
      .returning();
    if (!inserted) throw new Error('skills: insert returned no row');

    return c.json(inserted, 201);
  },
);

skillCrudRoutes.put(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', skillUpdateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const [row] = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
    if (!row) throw notFound('skill not found');

    if (row.projectId) {
      const ctx = await loadCallerRole(row.projectId, userId);
      if (ctx.ownerId !== userId && ctx.role !== 'owner' && ctx.role !== 'admin') {
        throw forbidden('only project owner or admin can update skills');
      }
    } else {
      // Global skills: only allow CEO/admin via existing admin route.
      throw forbidden('global skills cannot be updated via this endpoint');
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.skillMd !== undefined) {
      updates.skillMd = patch.skillMd;
      updates.prompt = patch.skillMd;
    }
    if (patch.target !== undefined) updates.target = patch.target;
    if (patch.files !== undefined) updates.files = patch.files;
    if (patch.localGuide !== undefined) updates.localGuide = patch.localGuide;
    if (patch.isGlobal !== undefined) {
      updates.scope = patch.isGlobal ? 'global' : 'project';
    }
    if (patch.skillMd !== undefined || patch.files !== undefined) {
      updates.contentHash = hashSkillBody(
        patch.skillMd ?? row.skillMd ?? row.prompt,
        patch.files ?? row.files,
      );
      updates.version = (row.version ?? 1) + 1;
    }

    const [updated] = await db.update(skills).set(updates).where(eq(skills.id, id)).returning();
    if (!updated) throw notFound('skill not found');

    return c.json(updated);
  },
);

skillCrudRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db
      .select({ id: skills.id, projectId: skills.projectId, scope: skills.scope })
      .from(skills)
      .where(eq(skills.id, id))
      .limit(1);
    if (!row) throw notFound('skill not found');

    if (row.projectId) {
      const ctx = await loadCallerRole(row.projectId, userId);
      if (ctx.ownerId !== userId && ctx.role !== 'owner') {
        throw forbidden('only project owner can delete skills');
      }
    } else {
      throw forbidden('global skills cannot be deleted via this endpoint');
    }

    await db.delete(skills).where(eq(skills.id, id));
    return c.body(null, 204);
  },
);

skillCrudRoutes.post(
  '/sync-status',
  zValidator('json', syncStatusSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('json');
    const userId = c.get('userId');

    const ctx = await loadCallerRole(projectId, userId);
    if (!ctx.role && ctx.ownerId !== userId) throw forbidden('not a project member');

    // Project skills + global skills relevant to this project.
    const projectSkills = await db
      .select({
        id: skills.id,
        name: skills.name,
        target: skills.target,
        scope: skills.scope,
        contentHash: skills.contentHash,
        version: skills.version,
        updatedAt: skills.updatedAt,
      })
      .from(skills)
      .where(or(eq(skills.scope, 'global'), eq(skills.projectId, projectId)) as SQL);

    if (projectSkills.length === 0) return c.json([]);

    const skillIds = projectSkills.map((s) => s.id);
    const registrations = await db
      .select({
        skillId: skillRegistrations.skillId,
        stage: skillRegistrations.stage,
      })
      .from(skillRegistrations)
      .where(
        and(
          eq(skillRegistrations.projectId, projectId),
          inArray(skillRegistrations.skillId, skillIds),
        ),
      );

    const stagesBySkill = new Map<string, string[]>();
    for (const reg of registrations) {
      const arr = stagesBySkill.get(reg.skillId) ?? [];
      arr.push(reg.stage);
      stagesBySkill.set(reg.skillId, arr);
    }

    const result = projectSkills.map((s) => ({
      skillId: s.id,
      skillName: s.name,
      target: s.target,
      scope: s.scope,
      currentHash: s.contentHash,
      currentVersion: s.version,
      updatedAt: s.updatedAt,
      registeredStages: stagesBySkill.get(s.id) ?? [],
    }));

    return c.json(result);
  },
);

skillCrudRoutes.post(
  '/bulk-push',
  zValidator('json', bulkPushSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { targets, projectId, skillNames } = c.req.valid('json');
    const userId = c.get('userId');

    const ctx = await loadCallerRole(projectId, userId);
    if (ctx.ownerId !== userId && ctx.role !== 'owner' && ctx.role !== 'admin') {
      throw forbidden('only project owner or admin can push skills');
    }

    const results: Array<{ target: string; status: string; jobId: string | null; error?: string }> = [];
    for (const target of targets) {
      try {
        const [job] = await db
          .insert(jobs)
          .values({
            projectId,
            createdBy: userId,
            type: 'custom',
            payload: {
              kind: 'skill.push',
              target,
              projectId,
              skillNames: skillNames ?? null,
            },
            status: 'queued',
          })
          .returning({ id: jobs.id });
        if (!job) {
          results.push({ target, status: 'failed', jobId: null, error: 'insert returned no row' });
          continue;
        }
        try {
          await enqueueJob(job.id);
        } catch (err) {
          logger.error({ err, jobId: job.id }, 'skills.bulkPush: enqueueJob failed');
        }
        results.push({ target, status: 'queued', jobId: job.id });
      } catch (err) {
        const message = (err as Error).message;
        results.push({ target, status: 'failed', jobId: null, error: message });
      }
    }

    return c.json({ results });
  },
);
