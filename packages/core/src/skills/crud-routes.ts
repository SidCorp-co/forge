import { zValidator } from '@hono/zod-validator';
import { type SQL, and, asc, eq, inArray, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { skillRegistrations, skillTargets, skills } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { SkillContentBlockedError } from '../security/findings.js';
import { MANAGED_META_SKILLS } from './effective.js';
import { MetaSkillReservedError } from './meta-skills.js';
import {
  createProjectSkill,
  deleteProjectSkill,
  requestSkillSync,
  updateProjectSkill,
} from './service.js';

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
    files: z.array(fileSchema).optional(),
    localGuide: z.string().max(20_000).nullable().optional(),
    markRebased: z.boolean().optional(),
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
    // `targets` is kept for API back-compat with the web client; its values
    // ('dev'/'cloud') are no longer interpreted — an explicit push always
    // signals every device-bound runner of the project (or one `deviceId`).
    targets: z.array(z.string().min(1)).min(1).max(10).optional(),
    projectId: z.uuid(),
    deviceId: z.uuid().optional(),
    skillNames: z.array(z.string().min(1)).optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

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
      const access = await loadProjectAccess(projectId, userId);
      if (!access.role) throw forbidden('not a project member');
      conditions.push(and(eq(skills.scope, 'project'), eq(skills.projectId, projectId)) as SQL);
    } else {
      // default + 'all': global ∪ project (if projectId)
      if (projectId) {
        const access = await loadProjectAccess(projectId, userId);
        if (!access.role) throw forbidden('not a project member');
        const projectCond = and(
          eq(skills.scope, 'project'),
          eq(skills.projectId, projectId),
        ) as SQL;
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

    // Tag platform-managed META skills (forge-skills…) so the Skill Studio UI
    // can render them as MCP-served live prompts — NOT disk-synced skills (no
    // sync-status, no stage registration). Computed from the core constant, by
    // name, so both the global template and any project-adopted copy carry it.
    const metaNames = new Set<string>(MANAGED_META_SKILLS);
    return c.json(rows.map((r) => ({ ...r, managedMeta: metaNames.has(r.name) })));
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
      const access = await loadProjectAccess(row.projectId, userId);
      if (!access.role) throw forbidden('not a project member');
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

    // Mirror PUT/DELETE: global skills are managed via the admin route only.
    // Without this gate any authenticated user could broadcast a skill to
    // every project by sending isGlobal=true.
    if (isGlobal) {
      throw forbidden('global skills cannot be created via this endpoint');
    }

    if (!input.projectId) {
      throw badRequest({ projectId: 'required when isGlobal=false' });
    }

    const access = await loadProjectAccess(input.projectId, userId);
    assertProjectRole(access, 'admin', 'only a project admin can create skills');

    try {
      const inserted = await createProjectSkill({
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        skillMd: input.skillMd,
        target: input.target ?? null,
        files: input.files,
        localGuide: input.localGuide ?? null,
      });
      return c.json(inserted, 201);
    } catch (err) {
      if (err instanceof SkillContentBlockedError) {
        throw new HTTPException(400, {
          message: 'SKILL_CONTENT_BLOCKED',
          cause: { code: 'SKILL_CONTENT_BLOCKED', details: { findings: err.findings } },
        });
      }
      if (err instanceof MetaSkillReservedError) {
        throw new HTTPException(400, {
          message: err.message,
          cause: { code: 'META_SKILL_RESERVED' },
        });
      }
      throw err;
    }
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
      const access = await loadProjectAccess(row.projectId, userId);
      assertProjectRole(access, 'admin', 'only a project admin can update skills');
    } else {
      // Global skills: only allow CEO/admin via existing admin route.
      throw forbidden('global skills cannot be updated via this endpoint');
    }

    try {
      const updated = await updateProjectSkill(row, patch);
      return c.json(updated);
    } catch (err) {
      if (err instanceof SkillContentBlockedError) {
        throw new HTTPException(400, {
          message: 'SKILL_CONTENT_BLOCKED',
          cause: { code: 'SKILL_CONTENT_BLOCKED', details: { findings: err.findings } },
        });
      }
      if (err instanceof MetaSkillReservedError) {
        throw new HTTPException(400, {
          message: err.message,
          cause: { code: 'META_SKILL_RESERVED' },
        });
      }
      throw err;
    }
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
      const access = await loadProjectAccess(row.projectId, userId);
      assertProjectRole(access, 'admin', 'only a project admin can delete skills');
    } else {
      throw forbidden('global skills cannot be deleted via this endpoint');
    }

    await deleteProjectSkill(id);
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

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

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
    const { projectId, deviceId, skillNames } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'only a project admin can push skills');

    // Explicit push: signal device-bound runners (or one `deviceId`) over WS;
    // each pulls its effective manifest and reports installed hashes back.
    // No pipeline_run / job is created — skill sync is not pipeline work.
    const { deviceIds } = await requestSkillSync({
      projectId,
      actorUserId: userId,
      skillNames: skillNames ?? null,
      deviceId,
    });

    const results = deviceIds.map((id) => ({
      target: id,
      status: 'signalled' as const,
      deviceId: id,
    }));
    return c.json({ results, deviceCount: deviceIds.length });
  },
);
