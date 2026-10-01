import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type IssueBranchOverride, resolveIssueBranches } from '../branches/resolve.js';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import {
  devices,
  issues,
  labels,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  runners,
} from '../db/schema.js';
import {
  assertOrgAccess,
  assertOrgRoleOnProject,
  assertProjectRole,
  assertUnfenced,
  loadPersonalOrgId,
  loadProjectAccess,
  maxProjectRole,
  orgDerivedProjectRole,
  visibleProjectsWhere,
} from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { pluginDesignationsPatchSchema } from '../plugins/designation.js';
import { type AgentConfigKeyPatch, patchAgentConfigKeys, readAgentConfig } from './agent-config.js';
import { assistantWeeklySchema } from './agent-config-schema.js';
import { applyIssuePrefixPatch } from './issue-prefix-patch.js';
import { projectOnboardRoutes } from './onboard-routes.js';
import { projectFactsRoutes } from './project-facts-routes.js';
import { PATCHED_PROJECT, PROJECT_DETAIL } from './projections.js';
import {
  refuseRetiredProjectFields,
  refuseRetiredProjectKeys,
  undeclaredFieldError,
} from './retired-project-keys.js';
import { badRequest, flatten, forbidden, idParamSchema, notFound } from './route-errors.js';
import { projectRunnerRoutes } from './runners-routes.js';
import { createProject, generateApiKey, ProjectSlugTakenError } from './service.js';

const createProjectFields = {
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens')
    .min(3)
    .max(64),
  name: z.string().trim().min(1).max(200),
  orgId: z.uuid().optional(),
};

export const createProjectSchema = z.strictObject(createProjectFields, {
  error: undeclaredFieldError('POST /api/projects', Object.keys(createProjectFields)),
});

export const createProjectBodySchema = z
  .unknown()
  .superRefine(refuseRetiredProjectFields)
  .pipe(createProjectSchema);

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

const updateProjectFields = {
  name: z.string().trim().min(1).max(200).optional(),
  repoUrl: z.string().trim().max(500).nullable().optional(),
  workspaceSetup: z.string().trim().max(8000).nullable().optional(),
  baseBranch: z.string().trim().max(100).nullable().optional(),
  issuePrefix: z.string().trim().max(16).nullable().optional(),
  assistantWeekly: assistantWeeklySchema.nullable().optional(),
  webhookSecret: z.string().min(16).max(128).nullable().optional(),
  // Move the project to another org. Requires org owner/admin on BOTH the
  // current org (route gate) and the target org (checked in the handler).
  orgId: z.uuid().optional(),
};

const undeclaredProjectField = undeclaredFieldError(
  'PATCH /api/projects/:id',
  Object.keys(updateProjectFields),
);

export const updateProjectSchema = z
  .strictObject(updateProjectFields, {
    error: (issue) => {
      const named = undeclaredProjectField(issue);
      return named === undefined
        ? undefined
        : `${named} Where a project's work lands, its environments, promotions and deployments are its project document: read GET /api/projects/:id/config and write PUT /api/projects/:id/config.`;
    },
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

export const updateProjectPatchSchema = z
  .unknown()
  .superRefine(refuseRetiredProjectKeys)
  .pipe(updateProjectSchema);

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const projectRoutes = new Hono<{ Variables: AuthVars }>();

projectRoutes.use('*', requireAuth(), assertEmailVerified());

projectRoutes.post(
  '/',
  zValidator('json', createProjectBodySchema, (result) => {
    if (!result.success) {
      throw badRequest(flatten(result.error));
    }
  }),
  async (c) => {
    assertUnfenced('creating a project');
    const { slug, name, orgId: requestedOrgId } = c.req.valid('json');
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
      const created = await createProject({
        slug,
        name,
        orgId,
        createdBy: userId,
      });

      return c.json(created, 201);
    } catch (err: unknown) {
      if (err instanceof ProjectSlugTakenError) {
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
      issuePrefix: projects.issuePrefix,
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
      and(...visibleProjectsWhere(), ...(includeArchived ? [] : [isNull(projects.archivedAt)])),
    )
    // DISTINCT ON requires its leading ORDER BY expression to match the
    // distinct column. Without this the list order was arbitrary/run-varying,
    // so a refetch could reorder it and shift list[0] — the rail's raw-order
    // fallback (ISS-734) then jumps every workspace tab in the same org onto
    // the new list[0] at once. Console display is unaffected (client-sorted).
    .orderBy(projects.id);

  // apiKey is returned as-is — the caller has effective access (ADR 0013
  // documents the key is embedded in the widget page anyway). Redacting broke
  // the desktop MCP install (key.length < 16 → 401) and the web widget
  // snippet generator.
  return c.json(
    rows.map(({ memberRole, orgRole, apiKey, ...row }) => {
      const role = maxProjectRole(memberRole ?? null, orgDerivedProjectRole(orgRole ?? null));
      return {
        ...row,
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
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    if (!access.role) throw forbidden('not a project member');

    const [project] = await db
      .select(PROJECT_DETAIL)
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
      .where(and(eq(runners.projectId, id), eq(runners.type, 'claude-code')));

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
    if (!result.success) throw badRequest(flatten(result.error));
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
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  zValidator('json', updateProjectPatchSchema, (result) => {
    if (result.success) return;
    throw badRequest(flatten(result.error));
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
    if (patch.repoUrl !== undefined) updates.repoUrl = patch.repoUrl;
    if (patch.baseBranch !== undefined) updates.baseBranch = patch.baseBranch;
    if (patch.workspaceSetup !== undefined) updates.workspaceSetup = patch.workspaceSetup;

    const agentConfigPatch: AgentConfigKeyPatch = {};
    if (patch.assistantWeekly !== undefined)
      agentConfigPatch.assistantWeekly = patch.assistantWeekly;
    if (patch.webhookSecret !== undefined) updates.webhookSecret = patch.webhookSecret;

    const [updated] = await db.transaction(async (tx) => {
      await patchAgentConfigKeys(id, agentConfigPatch, tx);
      if (patch.issuePrefix !== undefined) {
        await applyIssuePrefixPatch(id, patch.issuePrefix, userId, tx);
      }
      if (Object.keys(updates).length === 0) {
        return tx.select(PATCHED_PROJECT).from(projects).where(eq(projects.id, id)).limit(1);
      }
      return tx.update(projects).set(updates).where(eq(projects.id, id)).returning(PATCHED_PROJECT);
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
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    assertOrgRoleOnProject(access, 'admin', 'org admin required');

    await withKernelMarker(db, async (tx) => tx.delete(projects).where(eq(projects.id, id)));
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
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    assertOrgRoleOnProject(access, 'admin', 'org admin required');

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
    if (!result.success) throw badRequest(flatten(result.error));
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

projectRoutes.patch(
  '/:id/plugins',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  zValidator('json', z.object({ plugins: pluginDesignationsPatchSchema }), (result) => {
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { plugins } = c.req.valid('json');
    const access = await loadProjectAccess(id, c.get('userId'));
    assertOrgRoleOnProject(access, 'admin', 'org admin required');

    if ((await readAgentConfig(id)) === null) throw notFound();
    await patchAgentConfigKeys(id, { plugins });

    return c.json({ plugins: plugins ?? [] });
  },
);

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
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  async (c) => {
    const { id, issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    if (!access.role) throw forbidden('not a project member');

    const [project] = await db
      .select({ baseBranch: projects.baseBranch })
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

// ISS-733 — POST /:id/onboard. The "Build Project Brain" trigger; the thin
// HTTP delegate lives in ./onboard-routes.ts.
projectRoutes.route('/', projectOnboardRoutes);
