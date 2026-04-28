import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { devices, labels, projectDevices, projectMembers, projects } from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { isEnabled } from '../lib/feature-flags.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  PIPELINE_CONFIG_DEFAULTS,
  type PipelineConfig,
  pipelineConfigPatchSchema,
  pipelineConfigSchema,
} from '../pipeline/pipeline-config-schema.js';

function generateApiKey(): string {
  return `fk_${randomBytes(24).toString('hex')}`;
}

function redactApiKey(key: string | null): string | null {
  if (!key) return null;
  // Generated keys are 51 chars (`fk_` + 48 hex). The branch below is
  // unreachable for keys produced by `generateApiKey`; it's a defensive
  // fallback for legacy/short keys discovered in the wild and renders an
  // unambiguous "exists but not previewable" placeholder rather than the
  // null we'd otherwise indistinguish from "no key at all".
  if (key.length < 8) return 'fk_…';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export const createProjectSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens')
    .min(3)
    .max(64),
  name: z.string().trim().min(1).max(200),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    repoPath: z.string().trim().max(500).nullable().optional(),
    baseBranch: z.string().trim().max(100).nullable().optional(),
    productionBranch: z.string().trim().max(100).nullable().optional(),
    defaultDeviceId: z.uuid().nullable().optional(),
    agentConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    webhookSecret: z.string().min(16).max(128).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

const idParamSchema = z.object({
  id: z.uuid(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

const notFound = () =>
  new HTTPException(404, { message: 'project not found', cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

async function loadMembership(projectId: string, userId: string) {
  const [project] = await db
    .select({ id: projects.id, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound();

  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);

  return { project, role: member?.role ?? null };
}

export const projectRoutes = new Hono<{ Variables: AuthVars }>();

projectRoutes.use('*', requireAuth(), assertEmailVerified());

projectRoutes.post(
  '/',
  zValidator('json', createProjectSchema, (result) => {
    if (!result.success) {
      throw badRequest(z.flattenError(result.error));
    }
  }),
  async (c) => {
    const { slug, name } = c.req.valid('json');
    const userId = c.get('userId');

    try {
      const created = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(projects)
          .values({ slug, name, ownerId: userId, apiKey: generateApiKey() })
          .returning({
            id: projects.id,
            slug: projects.slug,
            name: projects.name,
            ownerId: projects.ownerId,
            createdAt: projects.createdAt,
          });
        const project = inserted[0];
        if (!project) {
          throw new Error('projects: insert returned no row');
        }

        await tx.insert(projectMembers).values({
          userId,
          projectId: project.id,
          role: 'owner',
        });

        return project;
      });

      return c.json(created, 201);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new HTTPException(409, {
          message: 'slug already taken',
          cause: { code: 'SLUG_TAKEN' },
        });
      }
      throw err;
    }
  },
);

projectRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      ownerId: projects.ownerId,
      role: projectMembers.role,
      apiKey: projects.apiKey,
      createdAt: projects.createdAt,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, userId));

  return c.json(rows.map((r) => ({ ...r, apiKey: redactApiKey(r.apiKey) })));
});

projectRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const { role } = await loadMembership(id, userId);
    if (!role) throw forbidden('not a project member');

    const [project] = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        ownerId: projects.ownerId,
        description: projects.description,
        repoPath: projects.repoPath,
        baseBranch: projects.baseBranch,
        productionBranch: projects.productionBranch,
        defaultDeviceId: projects.defaultDeviceId,
        agentConfig: projects.agentConfig,
        webhookSecret: projects.webhookSecret,
        apiKey: projects.apiKey,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    if (!project) throw notFound();

    const members = await db
      .select({ userId: projectMembers.userId, role: projectMembers.role })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, id));

    const labelRows = await db
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(labels)
      .where(eq(labels.projectId, id));

    const devicePool = await db
      .select({
        id: devices.id,
        name: devices.name,
        platform: devices.platform,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
      })
      .from(projectDevices)
      .innerJoin(devices, eq(devices.id, projectDevices.deviceId))
      .where(eq(projectDevices.projectId, id));

    return c.json({
      ...project,
      apiKey: redactApiKey(project.apiKey),
      members,
      labels: labelRows,
      devicePool,
    });
  },
);

projectRoutes.post(
  '/:id/api-key/rotate',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const { project, role } = await loadMembership(id, userId);
    if (project.ownerId !== userId && role !== 'owner' && role !== 'admin') {
      throw forbidden('owner or admin required');
    }

    // Retry on the partial unique index violation. With 192 bits of
    // entropy a collision is astronomical, but the `create` path already
    // wraps inserts in `isUniqueViolation`; mirror the pattern so a freak
    // collision presents as a 503 rather than an opaque 500.
    let updated: { id: string; apiKey: string | null } | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const apiKey = generateApiKey();
        [updated] = await db
          .update(projects)
          .set({ apiKey })
          .where(eq(projects.id, id))
          .returning({ id: projects.id, apiKey: projects.apiKey });
        break;
      } catch (err) {
        if (isUniqueViolation(err)) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    if (!updated) {
      if (lastErr) {
        throw new HTTPException(503, {
          message: 'failed to mint a unique api key — try again',
          cause: { code: 'API_KEY_COLLISION' },
        });
      }
      throw notFound();
    }

    return c.json({ id: updated.id, apiKey: updated.apiKey });
  },
);

projectRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', updateProjectSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const { project, role } = await loadMembership(id, userId);
    if (project.ownerId !== userId && role !== 'owner') {
      throw forbidden('not a project owner');
    }

    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.repoPath !== undefined) updates.repoPath = patch.repoPath;
    if (patch.baseBranch !== undefined) updates.baseBranch = patch.baseBranch;
    if (patch.productionBranch !== undefined) updates.productionBranch = patch.productionBranch;
    if (patch.defaultDeviceId !== undefined) updates.defaultDeviceId = patch.defaultDeviceId;
    if (patch.agentConfig !== undefined) updates.agentConfig = patch.agentConfig;
    if (patch.webhookSecret !== undefined) updates.webhookSecret = patch.webhookSecret;

    const [updated] = await db.update(projects).set(updates).where(eq(projects.id, id)).returning({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      ownerId: projects.ownerId,
      description: projects.description,
      repoPath: projects.repoPath,
      baseBranch: projects.baseBranch,
      productionBranch: projects.productionBranch,
      defaultDeviceId: projects.defaultDeviceId,
      agentConfig: projects.agentConfig,
      webhookSecret: projects.webhookSecret,
      createdAt: projects.createdAt,
    });
    if (!updated) throw notFound();

    return c.json(updated);
  },
);

const deviceParamSchema = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
});

projectRoutes.put(
  '/:id/devices/:deviceId',
  zValidator('param', deviceParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id, deviceId } = c.req.valid('param');
    const userId = c.get('userId');

    const { project, role } = await loadMembership(id, userId);
    if (project.ownerId !== userId && role !== 'owner' && role !== 'admin') {
      throw forbidden('owner or admin required');
    }

    try {
      await db.insert(projectDevices).values({ projectId: id, deviceId }).onConflictDoNothing();
    } catch (err) {
      if (isUniqueViolation(err)) {
        // already in pool — idempotent
      } else {
        throw err;
      }
    }
    return c.body(null, 204);
  },
);

projectRoutes.delete(
  '/:id/devices/:deviceId',
  zValidator('param', deviceParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id, deviceId } = c.req.valid('param');
    const userId = c.get('userId');

    const { project, role } = await loadMembership(id, userId);
    if (project.ownerId !== userId && role !== 'owner' && role !== 'admin') {
      throw forbidden('owner or admin required');
    }

    await db
      .delete(projectDevices)
      .where(and(eq(projectDevices.projectId, id), eq(projectDevices.deviceId, deviceId)));
    return c.body(null, 204);
  },
);

projectRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const { project, role } = await loadMembership(id, userId);
    if (project.ownerId !== userId && role !== 'owner') {
      throw forbidden('not a project owner');
    }

    await db.delete(projects).where(eq(projects.id, id));
    return c.body(null, 204);
  },
);

// ─── Pipeline configuration ──────────────────────────────────────────────────
//
// Dedicated read/patch routes for `agentConfig.pipelineConfig`. The main
// PATCH /:id route still accepts a wide-open `agentConfig` jsonb (other
// settings tabs need that escape hatch) — these routes give the pipeline
// settings UI a typed, validated, atomic-merge surface so two tabs writing
// to different `agentConfig` sub-keys never clobber each other.
//
// Gated on `pipelineControl` feature flag; off by default in production.

const pipelineFlagOff = () =>
  new HTTPException(404, {
    message: 'pipeline configuration disabled',
    cause: { code: 'FEATURE_OFF' },
  });

projectRoutes.get(
  '/:id/pipeline-config',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    if (!isEnabled('pipelineControl')) throw pipelineFlagOff();

    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const { role } = await loadMembership(id, userId);
    if (!role) throw forbidden('not a project member');

    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    if (!row) throw notFound();

    const ac = (row.agentConfig ?? {}) as Record<string, unknown>;
    const stored = (ac.pipelineConfig ?? {}) as Record<string, unknown>;
    // Parse through schema — drops legacy keys (autoClarify, etc.) so the
    // response is the typed surface the FE expects. Defaults fill blanks.
    const parsed = pipelineConfigSchema.parse(stored);
    const pipelineConfig: PipelineConfig = { ...PIPELINE_CONFIG_DEFAULTS, ...parsed };

    const runnerFallback = Array.isArray(ac.runnerFallback)
      ? (ac.runnerFallback as string[])
      : ['claude-code'];

    return c.json({ pipelineConfig, runnerFallback });
  },
);

projectRoutes.patch(
  '/:id/pipeline-config',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', pipelineConfigPatchSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    if (!isEnabled('pipelineControl')) throw pipelineFlagOff();

    const { id } = c.req.valid('param');
    const { runnerFallback, ...pipelinePatch } = c.req.valid('json');
    const userId = c.get('userId');

    const { project, role } = await loadMembership(id, userId);
    if (project.ownerId !== userId && role !== 'owner') {
      throw forbidden('not a project owner');
    }

    // Atomic jsonb merge at the DB level. Writes pipelineConfig as a sub-key
    // (so unknown legacy keys round-trip) AND optionally runnerFallback as a
    // sibling — both in one UPDATE so they cannot interleave with another
    // tab's write.
    const mergeDoc: Record<string, unknown> = {};
    if (Object.keys(pipelinePatch).length > 0) {
      mergeDoc.pipelineConfig = pipelinePatch;
    }
    if (runnerFallback !== undefined) {
      mergeDoc.runnerFallback = runnerFallback;
    }

    if (Object.keys(mergeDoc).length > 0) {
      // Two-level merge: top-level keys (runnerFallback, pipelineConfig) are
      // shallow-merged via `||`. Then for pipelineConfig specifically, we
      // also need to deep-merge so partial step toggles don't wipe the rest.
      // Approach: pre-merge pipelineConfig in JS using the loaded doc, then
      // emit a single atomic write at the agentConfig level.
      const [row] = await db
        .select({ agentConfig: projects.agentConfig })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      if (!row) throw notFound();
      const currentAc = (row.agentConfig ?? {}) as Record<string, unknown>;
      const currentPipeline = (currentAc.pipelineConfig ?? {}) as Record<string, unknown>;
      const nextDoc: Record<string, unknown> = {};
      if (mergeDoc.pipelineConfig) {
        nextDoc.pipelineConfig = { ...currentPipeline, ...(mergeDoc.pipelineConfig as object) };
      }
      if (runnerFallback !== undefined) {
        nextDoc.runnerFallback = runnerFallback;
      }
      const subkey = JSON.stringify(nextDoc);
      await db.execute(
        sql`UPDATE projects
            SET agent_config = COALESCE(agent_config, '{}'::jsonb) || ${subkey}::jsonb
            WHERE id = ${id}`,
      );
    }

    // Re-read to compose the canonical merged response.
    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    if (!row) throw notFound();
    const ac = (row.agentConfig ?? {}) as Record<string, unknown>;
    const stored = (ac.pipelineConfig ?? {}) as Record<string, unknown>;
    const parsed = pipelineConfigSchema.parse(stored);
    const pipelineConfig: PipelineConfig = { ...PIPELINE_CONFIG_DEFAULTS, ...parsed };
    const respRunnerFallback = Array.isArray(ac.runnerFallback)
      ? (ac.runnerFallback as string[])
      : ['claude-code'];

    return c.json({ pipelineConfig, runnerFallback: respRunnerFallback });
  },
);
