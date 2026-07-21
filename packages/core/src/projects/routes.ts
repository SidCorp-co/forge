import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type IssueBranchOverride, resolveIssueBranches } from '../branches/resolve.js';
import { db } from '../db/client.js';
import {
  devices,
  issues,
  labels,
  organizationMembers,
  organizations,
  projectKinds,
  projectMembers,
  projects,
  runners,
} from '../db/schema.js';
import {
  assertOrgAccess,
  assertOrgRoleOnProject,
  assertProjectRole,
  loadPersonalOrgId,
  loadProjectAccess,
  maxProjectRole,
  orgDerivedProjectRole,
} from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { isEnabled } from '../lib/feature-flags.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  PIPELINE_CONFIG_DEFAULTS,
  type PipelineConfig,
  pipelineConfigPatchSchema,
  pipelineConfigSchema,
} from '../pipeline/pipeline-config-schema.js';
import { PipelineConfigError, updatePipelineConfig } from '../pipeline/pipeline-config-service.js';
import { readAgentConfig } from './agent-config.js';
import { projectFactsRoutes } from './project-facts-routes.js';
import { projectRunnerRoutes } from './runners-routes.js';
import { skillsBootstrapRoutes } from './skills-bootstrap-routes.js';
import { mergeStateContext, stateContextSchema } from './state-context.js';

function generateApiKey(): string {
  return `fk_${randomBytes(24).toString('hex')}`;
}

export const createProjectSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens')
    .min(3)
    .max(64),
  name: z.string().trim().min(1).max(200),
  // ISS-273 — `projects.description` already exists; the create path now
  // persists it instead of silently dropping the field the modal collects.
  description: z.string().trim().max(2000).nullable().optional(),
  // ISS-387 — project kind. `standard` (default) = code repo project;
  // `website` = an Epodsystem storefront project (git repo optional).
  kind: z.enum(projectKinds).optional(),
  // Org tier — every project belongs to exactly one org. Omitted = the
  // caller's personal org. Any org role (incl. member) may create projects.
  orgId: z.uuid().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

const testingUrlSchema = z.object({
  label: z.string().trim().min(1).max(80),
  url: z.string().trim().url().max(500),
});

const testCredentialSchema = z.object({
  label: z.string().trim().min(1).max(80),
  username: z.string().trim().max(200),
  password: z.string().max(500),
});

// Free-form jsonb so future deploy knobs can be added without a migration.
// Known fields are validated; unknown keys pass through unchanged.
export const previewDeployPatchSchema = z
  .object({
    stagingUrl: z.string().trim().url().max(500).nullable().optional(),
    stagingApiUrl: z.string().trim().url().max(500).nullable().optional(),
    testingUrls: z.array(testingUrlSchema).max(50).optional(),
    testCredentials: z.array(testCredentialSchema).max(50).optional(),
  })
  .catchall(z.unknown());

export type PreviewDeployConfig = z.infer<typeof previewDeployPatchSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    repoPath: z.string().trim().max(500).nullable().optional(),
    repoUrl: z.string().trim().max(500).nullable().optional(),
    baseBranch: z.string().trim().max(100).nullable().optional(),
    productionBranch: z.string().trim().max(100).nullable().optional(),
    defaultDeviceId: z.uuid().nullable().optional(),
    agentConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    // ISS-609 follow-up — scoped write for `agentConfig.personaStyle` (the
    // chat/RC-bot reply-style knob) so the UI never round-trips the whole
    // agentConfig jsonb. null/'' clears the style.
    personaStyle: z.string().trim().max(4000).nullable().optional(),
    // ISS-727 — scoped write for `agentConfig.rocketChatAnswerMode` (the RC
    // bot answer-engine knob: `fast` provider-chat vs `agent` runner Claude).
    // null clears it (reverts to the `fast` default).
    rocketChatAnswerMode: z.enum(['fast', 'agent']).nullable().optional(),
    previewDeploy: previewDeployPatchSchema.nullable().optional(),
    webhookSecret: z.string().min(16).max(128).nullable().optional(),
    stateContext: stateContextSchema.nullable().optional(),
    // Move the project to another org. Requires org owner/admin on BOTH the
    // current org (route gate) and the target org (checked in the handler).
    orgId: z.uuid().optional(),
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
  new HTTPException(404, {
    message: 'project not found',
    cause: { code: 'NOT_FOUND' },
  });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

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
    const { slug, name, description, kind, orgId: requestedOrgId } = c.req.valid('json');
    const userId = c.get('userId');

    // Resolve the target org: explicit orgId (caller must be an org member of
    // any role) or the caller's personal org.
    let orgId: string;
    if (requestedOrgId) {
      await assertOrgAccess(requestedOrgId, userId, 'member');
      orgId = requestedOrgId;
    } else {
      const personal = await loadPersonalOrgId(userId);
      if (!personal) {
        throw new HTTPException(500, {
          message: 'personal org missing — run migrations',
          cause: { code: 'PERSONAL_ORG_MISSING' },
        });
      }
      orgId = personal;
    }

    try {
      const created = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(projects)
          .values({
            slug,
            name,
            orgId,
            createdBy: userId,
            apiKey: generateApiKey(),
            // ISS-274 — default the branch columns at create time so a new
            // project never resolves a null base/prod branch at pipeline time
            // (resolveIssueBranches deliberately has no 'main' fallback — see
            // branches/resolve.ts). createProjectSchema doesn't accept these
            // fields, so there is no explicit value to preserve here.
            baseBranch: 'main',
            productionBranch: 'main',
            ...(description !== undefined ? { description } : {}),
            ...(kind !== undefined ? { kind } : {}),
          })
          .returning({
            id: projects.id,
            slug: projects.slug,
            name: projects.name,
            orgId: projects.orgId,
            createdBy: projects.createdBy,
            apiKey: projects.apiKey,
            createdAt: projects.createdAt,
          });
        const project = inserted[0];
        if (!project) {
          throw new Error('projects: insert returned no row');
        }

        await tx.insert(projectMembers).values({
          userId,
          projectId: project.id,
          role: 'admin',
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
  // ISS-353 — archived projects are excluded by default so existing callers
  // (switcher, dashboard) don't see them. `?archived=1` includes them, for an
  // explicit "Archived" view. `archivedAt` must be in the select projection or
  // the UI can't render archived state (see memory
  // `web:useProjectBySlug-omits-branch-fields`).
  const includeArchived = ['1', 'true'].includes((c.req.query('archived') ?? '').toLowerCase());
  // Visible = explicit membership (any role) OR org owner/admin on the
  // project's org (implicit admin) — same rule as lib/authz.ts.
  const rows = await db
    .selectDistinctOn([projects.id], {
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      orgId: projects.orgId,
      orgName: organizations.name,
      orgIsPersonal: organizations.isPersonal,
      createdBy: projects.createdBy,
      memberRole: projectMembers.role,
      orgRole: organizationMembers.role,
      apiKey: projects.apiKey,
      archivedAt: projects.archivedAt,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.userId, userId)),
    )
    .where(
      and(
        sql`${projectMembers.userId} IS NOT NULL OR ${organizationMembers.role} IN ('owner', 'admin')`,
        ...(includeArchived ? [] : [isNull(projects.archivedAt)]),
      ),
    );

  // apiKey is returned as-is — the caller has effective access (ADR 0013
  // documents the key is embedded in the widget page anyway). Redacting broke
  // the desktop MCP install (key.length < 16 → 401) and the web widget
  // snippet generator.
  return c.json(
    rows.map(({ memberRole, orgRole, apiKey, ...row }) => {
      const role = maxProjectRole(memberRole ?? null, orgDerivedProjectRole(orgRole ?? null));
      return {
        ...row,
        // Viewer is read-only: the apiKey can pair MCP devices / install the
        // widget (execution-grade), so it is withheld from the viewer tier.
        apiKey: role === 'viewer' ? null : apiKey,
        role,
        orgRole: orgRole ?? null,
      };
    }),
  );
});

projectRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    if (!access.role) throw forbidden('not a project member');

    const [project] = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        orgId: projects.orgId,
        createdBy: projects.createdBy,
        description: projects.description,
        repoPath: projects.repoPath,
        repoUrl: projects.repoUrl,
        baseBranch: projects.baseBranch,
        productionBranch: projects.productionBranch,
        defaultDeviceId: projects.defaultDeviceId,
        agentConfig: projects.agentConfig,
        previewDeploy: projects.previewDeploy,
        webhookSecret: projects.webhookSecret,
        apiKey: projects.apiKey,
        archivedAt: projects.archivedAt,
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

    // ISS-172 Slice A — devicePool now reads from `runners`. One device can
    // be a runner for N projects, so this is just the per-project slice of
    // the runners table filtered to `claude-code` device-host rows.
    const devicePool = await db
      .select({
        id: devices.id,
        name: devices.name,
        platform: devices.platform,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        runnerId: runners.id,
      })
      .from(runners)
      .innerJoin(devices, eq(devices.id, runners.deviceId))
      .where(
        and(eq(runners.projectId, id), eq(runners.type, 'claude-code'), eq(runners.host, 'device')),
      );

    // apiKey is returned for member+ (ADR 0013); the viewer tier is read-only
    // and the key is execution-grade (MCP pairing / widget), so it's withheld.
    return c.json({
      ...project,
      apiKey: access.role === 'viewer' ? null : project.apiKey,
      role: access.role,
      orgRole: access.orgRole,
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

    const access = await loadProjectAccess(id, userId);
    assertProjectRole(access, 'admin', 'project admin required');

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

    // Settings PATCH keeps the legacy owner-only strictness: org owner/admin,
    // not a merely-invited project admin.
    const access = await loadProjectAccess(id, userId);
    assertOrgRoleOnProject(access, 'admin', 'org admin required');

    const updates: Record<string, unknown> = {};
    if (patch.orgId !== undefined && patch.orgId !== access.orgId) {
      await assertOrgAccess(patch.orgId, userId, 'admin');
      updates.orgId = patch.orgId;
    }
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.repoPath !== undefined) updates.repoPath = patch.repoPath;
    if (patch.repoUrl !== undefined) updates.repoUrl = patch.repoUrl;
    if (patch.baseBranch !== undefined) updates.baseBranch = patch.baseBranch;
    if (patch.productionBranch !== undefined) updates.productionBranch = patch.productionBranch;
    if (patch.defaultDeviceId !== undefined) updates.defaultDeviceId = patch.defaultDeviceId;
    if (patch.stateContext !== undefined) {
      // Read-modify-write rather than Postgres's `jsonb || jsonb` (shallow
      // merge) so a `stateContext`-only patch can't wipe sibling keys
      // (`pipelineConfig`, `repoPath`, `categories`, …). Per-state merge
      // granularity is intentional — see `mergeStateContext` JSDoc. The write
      // is deferred to the single UPDATE below, so only the read is shared.
      const currentAc = (await readAgentConfig(id)) ?? {};
      const baseAc =
        patch.agentConfig !== undefined
          ? ((patch.agentConfig ?? {}) as Record<string, unknown>)
          : { ...currentAc };
      const existingSc = patch.agentConfig !== undefined ? undefined : currentAc.stateContext;
      const mergedSc = mergeStateContext(existingSc, patch.stateContext);
      if (mergedSc === null) {
        baseAc.stateContext = undefined;
      } else {
        baseAc.stateContext = mergedSc;
      }
      updates.agentConfig = baseAc;
    } else if (patch.agentConfig !== undefined) {
      updates.agentConfig = patch.agentConfig;
    }
    if (patch.personaStyle !== undefined) {
      // Scoped agentConfig.personaStyle write — read-modify-write (like
      // stateContext above) so a style-only patch can't wipe sibling keys.
      let baseAc = updates.agentConfig as Record<string, unknown> | undefined;
      if (baseAc === undefined) {
        baseAc = { ...((await readAgentConfig(id)) ?? {}) };
      }
      if (patch.personaStyle === null || patch.personaStyle.length === 0) {
        baseAc.personaStyle = undefined;
      } else {
        baseAc.personaStyle = patch.personaStyle;
      }
      updates.agentConfig = baseAc;
    }
    if (patch.rocketChatAnswerMode !== undefined) {
      // Scoped agentConfig.rocketChatAnswerMode write — read-modify-write
      // (like personaStyle above) so a mode-only patch can't wipe sibling keys.
      let baseAc = updates.agentConfig as Record<string, unknown> | undefined;
      if (baseAc === undefined) {
        baseAc = { ...((await readAgentConfig(id)) ?? {}) };
      }
      if (patch.rocketChatAnswerMode === null) {
        baseAc.rocketChatAnswerMode = undefined;
      } else {
        baseAc.rocketChatAnswerMode = patch.rocketChatAnswerMode;
      }
      updates.agentConfig = baseAc;
    }
    if (patch.previewDeploy !== undefined) updates.previewDeploy = patch.previewDeploy;
    if (patch.webhookSecret !== undefined) updates.webhookSecret = patch.webhookSecret;

    const [updated] = await db.update(projects).set(updates).where(eq(projects.id, id)).returning({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      orgId: projects.orgId,
      createdBy: projects.createdBy,
      description: projects.description,
      repoPath: projects.repoPath,
      repoUrl: projects.repoUrl,
      baseBranch: projects.baseBranch,
      productionBranch: projects.productionBranch,
      defaultDeviceId: projects.defaultDeviceId,
      agentConfig: projects.agentConfig,
      previewDeploy: projects.previewDeploy,
      webhookSecret: projects.webhookSecret,
      createdAt: projects.createdAt,
    });
    if (!updated) throw notFound();

    return c.json(updated);
  },
);

// ISS-172 Slice A — runner-shaped binding endpoints (GET/POST /:id/runners,
// PATCH/DELETE /:id/runners/:runnerId) live in ./runners-routes.ts. Mounted
// here (not in index.ts) so they inherit this router's requireAuth +
// assertEmailVerified middleware exactly as before the split.
projectRoutes.route('/', projectRunnerRoutes);

projectRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    assertOrgRoleOnProject(access, 'admin', 'org admin required');

    await db.delete(projects).where(eq(projects.id, id));
    return c.body(null, 204);
  },
);

// ─── Soft archive / unarchive (ISS-353) ──────────────────────────────────────
//
// Owner-only, mirroring the gate on PATCH/DELETE /:id. Archive sets
// `archived_at` to the DB clock; unarchive clears it. Both are idempotent and
// non-destructive — no project-owned data (issues, comments, runs, sessions)
// is touched. Archived projects drop out of the default GET / list and stop
// dispatching new auto-pipeline jobs (see orchestrator.loadPipelineConfig);
// in-flight jobs are unaffected. The hard DELETE /:id route above is unchanged.

const ARCHIVE_PROJECTION = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
  createdBy: projects.createdBy,
  apiKey: projects.apiKey,
  archivedAt: projects.archivedAt,
  createdAt: projects.createdAt,
} as const;

projectRoutes.post(
  '/:id/archive',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    assertOrgRoleOnProject(access, 'admin', 'org admin required');

    // `coalesce(archived_at, now())` keeps the ORIGINAL archive timestamp when
    // re-archiving an already-archived project (idempotent), and only stamps
    // the clock on the first archive. `now()` is a SQL literal, NOT an
    // interpolated JS Date — an untyped Date bind 500s on a timestamptz column
    // (memory `core/drizzle-date-param-needs-timestamptz-cast`).
    const [updated] = await db
      .update(projects)
      .set({ archivedAt: sql`coalesce(${projects.archivedAt}, now())` })
      .where(eq(projects.id, id))
      .returning(ARCHIVE_PROJECTION);
    if (!updated) throw notFound();
    return c.json(updated);
  },
);

projectRoutes.post(
  '/:id/unarchive',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    assertOrgRoleOnProject(access, 'admin', 'org admin required');

    const [updated] = await db
      .update(projects)
      .set({ archivedAt: null })
      .where(eq(projects.id, id))
      .returning(ARCHIVE_PROJECTION);
    if (!updated) throw notFound();
    return c.json(updated);
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

    const access = await loadProjectAccess(id, userId);
    if (!access.role) throw forbidden('not a project member');

    const ac = await readAgentConfig(id);
    if (ac === null) throw notFound();

    const stored = (ac.pipelineConfig ?? {}) as Record<string, unknown>;
    // Parse through schema — drops legacy keys (clarified, pipelineSteps,
    // etc.) so the response is the typed surface the FE expects. Defaults
    // fill blanks.
    const parsed = pipelineConfigSchema.parse(stored);
    const pipelineConfig: PipelineConfig = {
      ...PIPELINE_CONFIG_DEFAULTS,
      ...parsed,
    };

    // ISS-232 Phase 3 — `runnerFallback` was removed. The v2 selector picks
    // primary → standby deterministically with no type-chain fallback; per-
    // stage `runner` overrides on step toggles continue to work.
    return c.json({ pipelineConfig });
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
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    assertOrgRoleOnProject(access, 'admin', 'org admin required');

    try {
      const result = await updatePipelineConfig({ projectId: id, patch });
      return c.json(result);
    } catch (err) {
      if (err instanceof PipelineConfigError) {
        switch (err.code) {
          case 'OPEN_LOCKED_ON':
          case 'DEAD_END_CONFIG':
          case 'MERGE_STATE_DISABLED':
            throw new HTTPException(400, {
              message: err.message,
              cause: { code: err.code, details: err.details },
            });
          case 'STAGE_HAS_ISSUES':
          case 'AUTO_STAGE_NEEDS_SKILL':
          case 'MISSING_SKILL_FOR_ENABLED_STAGE':
            throw new HTTPException(409, {
              message: err.message,
              cause: { code: err.code, details: err.details },
            });
          case 'PROJECT_NOT_FOUND':
            throw notFound();
        }
      }
      throw err;
    }
  },
);

// ─── Project facts (ISS-521) ─────────────────────────────────────────────────
//
// GET/PATCH /:id/project-facts (incl. the knowledge_entries write-through
// deprecation shim) live in ./project-facts-routes.ts, next to
// ./project-facts.ts. Mounted here so they inherit this router's auth
// middleware exactly as before the split.
projectRoutes.route('/', projectFactsRoutes);

// ─── Branch config (ISS-135 PR-A) ───────────────────────────────────────────
//
// Resolved branch config for one issue. Layers per-issue override (currently
// read from `issues.sessionContext.branchConfig` — PR-C will add a dedicated
// `issues.metadata` column) on top of the project defaults. The endpoint
// returns the *resolved* shape only; the override source is an internal
// detail callers should not depend on.

const branchConfigParamSchema = z.object({
  id: z.uuid(),
  issueId: z.uuid(),
});

projectRoutes.get(
  '/:id/issues/:issueId/branch-config',
  zValidator('param', branchConfigParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id, issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    if (!access.role) throw forbidden('not a project member');

    const [project] = await db
      .select({
        baseBranch: projects.baseBranch,
        productionBranch: projects.productionBranch,
      })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    if (!project) throw notFound();

    const [issueRow] = await db
      .select({
        id: issues.id,
        sessionContext: issues.sessionContext,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.projectId, id)))
      .limit(1);
    if (!issueRow) {
      throw new HTTPException(404, {
        message: 'issue not found',
        cause: { code: 'NOT_FOUND' },
      });
    }

    // PR-C will add a real `issues.metadata` jsonb column. Until then accept
    // either shape; sessionContext.branchConfig is the forward-compat probe.
    const issueLike = issueRow as {
      metadata?: { branchConfig?: IssueBranchOverride | null } | null;
      sessionContext: unknown;
    };
    const metadataOverride =
      (
        issueLike.metadata as {
          branchConfig?: IssueBranchOverride | null;
        } | null
      )?.branchConfig ?? null;
    const sessionContextOverride =
      (
        issueLike.sessionContext as {
          branchConfig?: IssueBranchOverride | null;
        } | null
      )?.branchConfig ?? null;
    const branchConfigOverride: IssueBranchOverride | null =
      metadataOverride ?? sessionContextOverride;

    const resolved = resolveIssueBranches(
      { metadata: { branchConfig: branchConfigOverride } },
      project,
    );

    return c.json(resolved);
  },
);

// ISS-2A / ISS-453 — POST /:id/skills/bootstrap. The template sets, presets,
// and idempotent bootstrap workflow are skills-domain logic and live in
// ../skills/bootstrap-service.ts; the thin HTTP delegate lives in
// ./skills-bootstrap-routes.ts. Mounted here so it inherits this router's
// auth middleware exactly as before the split.
projectRoutes.route('/', skillsBootstrapRoutes);
