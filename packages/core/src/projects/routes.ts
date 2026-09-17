import { zValidator } from '@hono/zod-validator';
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
  visibleProjectsWhere,
} from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { isEnabled } from '../lib/feature-flags.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  PIPELINE_CONFIG_DEFAULTS,
  type PipelineConfig,
  pipelineConfigPatchSchema,
  pipelineConfigSchema,
  refuseRetiredStageKeys,
} from '../pipeline/pipeline-config-schema.js';
import { updatePipelineConfig } from '../pipeline/pipeline-config-service.js';
import { pluginDesignationsPatchSchema } from '../plugins/designation.js';
import { RETIRED_STATE_CONTEXT_MESSAGE, readAgentConfig } from './agent-config.js';
import { applyIssuePrefixPatch } from './issue-prefix-patch.js';
import { projectOnboardRoutes } from './onboard-routes.js';
import { pipelineConfigHttpError } from './pipeline-config-http.js';
import {
  environmentsPatchSchema,
  RETIRED_PREVIEW_DEPLOY_MESSAGE,
} from './environments.js';
import {
  RETIRED_PROJECT_FACTS_CONFIG_MESSAGE,
  RETIRED_PROJECT_FACTS_MESSAGE,
} from './project-facts.js';
import { projectFactsRoutes } from './project-facts-routes.js';
import { PATCHED_PROJECT, PROJECT_DETAIL } from './projections.js';
import { readableLiveBranch, releaseModelGap, releaseModelPatchFields } from './release-model.js';
import { projectRunnerRoutes } from './runners-routes.js';
import { createProject, generateApiKey, ProjectSlugTakenError } from './service.js';

export const createProjectSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens')
    .min(3)
    .max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  // cm:why ISS-387 — project kind. `standard` (default) = code repo project; `website` = an Epodsystem storefront project (git repo optional).
  kind: z.enum(projectKinds).optional(),
  // cm:guard omitted means the caller's PERSONAL org and never "no org" — every project belongs to exactly one, and any org role including plain member may create one here
  orgId: z.uuid().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    // cm:guard `kind` was create-only for two months, which made it unreachable for every project that already existed — including the one storefront it was added for (mowment stayed `standard` while ISS-808 was written about it being a storefront). A shape that can only be declared at birth is a shape nobody can correct.
    // cm:guard NOTHING reads this value. It was meant to switch off a git preflight for a storefront project, and the function that would have read it was never written — it existed only as a name inside four comments until ISS-1047 removed them, and `/me/runners` stopped carrying the field in the same change. `mowment` is set to `website` and has been inert for as long as it has been set, so treat this as a label until something reads it, and read docs/proposals/website-lane-has-no-working-directory.md before wiring one.
    kind: z.enum(projectKinds).optional(),
    repoPath: z.string().trim().max(500).nullable().optional(),
    repoUrl: z.string().trim().max(500).nullable().optional(),
    // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/setup_agent.rs — this text IS the setup agent's instruction set; it reaches the box via `/me/runners`, so a rename here silently gives every setup agent an empty procedure and sends it back to deriving one per job
    workspaceSetup: z.string().trim().max(8000).nullable().optional(),
    baseBranch: z.string().trim().max(100).nullable().optional(),
    ...releaseModelPatchFields,
    // cm:guard ISS-992 — the shape is checked in the handler, not here, because three of the four refusals need the database (the reserved name, the prefix another project holds, and whether the caller may be told which one). A zod regex here would answer the first and let the other three reach Postgres as a 500 on an ordinary conflict.
    issuePrefix: z.string().trim().max(16).nullable().optional(),
    defaultDeviceId: z.uuid().nullable().optional(),
    agentConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    // cm:why ISS-609 follow-up — a scoped write for the chat/RC-bot reply-style knob, so the UI never round-trips the whole `agentConfig` jsonb to change one string; `null` and `''` both clear it
    // cm:guard the cap leaves room for what migration 0245 PREPENDED — 82 characters plus a newline — because a project already at the old 4,000 came out of that migration longer than its own settings form would accept, and the field the person edits is Bot personality under Settings → Integrations → Rocket.Chat. `Dockerfile` runs the migrator before the server serves, so the widened cap and the rows it has to accept arrive together and are never observed half-applied (ISS-1007).
    personaStyle: z.string().trim().max(4100).nullable().optional(),
    // cm:why ISS-727 — the two values name two different ANSWERERS rather than two speeds: `fast` is the provider-chat turn this process runs, `agent` diverts the whole turn to a Claude session on a paired box. null clears it back to `fast`.
    rocketChatAnswerMode: z.enum(['fast', 'agent']).nullable().optional(),
    environments: environmentsPatchSchema.nullable().optional(),
    webhookSecret: z.string().min(16).max(128).nullable().optional(),
    // Move the project to another org. Requires org owner/admin on BOTH the
    // current org (route gate) and the target org (checked in the handler).
    orgId: z.uuid().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

/**
 * ISS-1000 — the retired keys, refused on the RAW body before the object above
 * strips them.
 *
 * `updateProjectSchema` drops an unknown key silently, so deleting
 * `stateContext` from it would answer the operator's save with a 200 and no
 * write, which is the same defect the retirement removes. And `agentConfig` on
 * this route is an untyped record assigned straight onto the column, so it is a
 * door past every refusal `pipelineConfigPatchSchema` makes — checked here for
 * the two retired stage keys and for nothing else, because typing the whole
 * blob is a different change.
 */
// cm:guard the walk refuses ONLY what has been retired. Widening it to validate `agentConfig` generally closes an escape hatch four other settings surfaces write through, and none of them is declared on this schema.
function refuseRetiredProjectKeys(raw: unknown, ctx: z.RefinementCtx): void {
  if (!raw || typeof raw !== 'object') return;
  const retired = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const body = raw as { stateContext?: unknown; agentConfig?: unknown };
  if ('stateContext' in body) retired(['stateContext'], RETIRED_STATE_CONTEXT_MESSAGE);
  // ISS-1069 — `previewDeploy` became `environments`. Refused here by name for the reason
  // `stateContext` is: the object below strips an undeclared key silently, which answers an
  // operator's save with a 200 and no write.
  if ('previewDeploy' in body) retired(['previewDeploy'], RETIRED_PREVIEW_DEPLOY_MESSAGE);
  const ac = body.agentConfig as { pipelineConfig?: unknown } | null | undefined;
  if (!ac || typeof ac !== 'object') return;
  if ('stateContext' in ac) retired(['agentConfig', 'stateContext'], RETIRED_STATE_CONTEXT_MESSAGE);
  // ISS-1048 — the raw record is still assigned straight onto the column, so a
  // write carrying either retired prose key would land it back in the blob the
  // migration emptied and the prompt no longer reads. Refused here by name for
  // the same reason `stateContext` is: the object below strips an undeclared key
  // silently, which answers the operator with a 200 and no write.
  if ('projectFacts' in ac) retired(['agentConfig', 'projectFacts'], RETIRED_PROJECT_FACTS_MESSAGE);
  if ('projectFactsConfig' in ac) {
    retired(['agentConfig', 'projectFactsConfig'], RETIRED_PROJECT_FACTS_CONFIG_MESSAGE);
  }
  const states = (ac.pipelineConfig as { states?: unknown } | null | undefined)?.states;
  refuseRetiredStageKeys(states, ctx, ['agentConfig', 'pipelineConfig', 'states']);
}

export const updateProjectPatchSchema = z
  .unknown()
  .superRefine(refuseRetiredProjectKeys)
  .pipe(updateProjectSchema);

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

const idParamSchema = z.object({
  id: z.uuid(),
});

/**
 * `z.flattenError`, with the path a nested field is actually at.
 *
 * ISS-1069 — `flattenError` buckets every issue under its TOP-LEVEL key and throws the rest of the
 * path away, which was survivable while this route's nested values were one level deep and stopped
 * being so with `environments`: a bad `live.commitPath`, a missing `testCredentials[0].username`
 * and a whitespace-only `preview.urls[2].label` all answered the operator with the same sentence,
 * `environments: Invalid input`. A refusal that cannot say WHERE is a refusal the caller has to
 * bisect by hand.
 *
 * The SHAPE is unchanged — `{ formErrors, fieldErrors }`, keyed on the top-level field — because
 * web-v2 renders it and every other route on this file answers with it. Only the message grows the
 * path it was always about.
 */
function flatten(error: z.ZodError): { formErrors: string[]; fieldErrors: Record<string, string[]> } {
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const [head, ...rest] = issue.path;
    if (head === undefined) {
      formErrors.push(issue.message);
      continue;
    }
    const key = String(head);
    const where = rest.length > 0 ? `${key}.${rest.join('.')}: ` : '';
    (fieldErrors[key] ??= []).push(`${where}${issue.message}`);
  }
  return { formErrors, fieldErrors };
}

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
      throw badRequest(flatten(result.error));
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
      const created = await createProject({
        slug,
        name,
        orgId,
        createdBy: userId,
        description,
        kind,
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
  // cm:guard `archivedAt` must stay in the select projection whatever `?archived=1` does — the flag decides which ROWS come back, the projection decides whether the UI can tell an archived one apart, and dropping it renders every row as live (ISS-353).
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
        // cm:guard the apiKey is execution-grade — it pairs MCP devices and installs the widget — so the viewer tier, which is read-only, never receives it
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
      // cm:guard the column is returned through the ONE rule that reads it. `releaseModel` travels
      // beside it so a caller can tell "this project promotes to no branch" from "this project does
      // not promote"; before ISS-1046 both answered the stale branch and neither said which.
      liveBranch: readableLiveBranch(project),
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
    if (!result.success) throw badRequest(flatten(result.error));
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
    if (patch.kind !== undefined) updates.kind = patch.kind;
    if (patch.repoPath !== undefined) updates.repoPath = patch.repoPath;
    if (patch.repoUrl !== undefined) updates.repoUrl = patch.repoUrl;
    if (patch.baseBranch !== undefined) updates.baseBranch = patch.baseBranch;
    if (patch.workspaceSetup !== undefined) updates.workspaceSetup = patch.workspaceSetup;
    if (patch.liveBranch !== undefined) updates.liveBranch = patch.liveBranch;
    if (patch.releaseModel !== undefined) updates.releaseModel = patch.releaseModel;
    if (patch.releaseStrategy !== undefined) updates.releaseStrategy = patch.releaseStrategy;
    const gap = await releaseModelGap(id, updates);
    if (gap) throw new HTTPException(400, { message: gap.message, cause: { code: gap.code } });
    if (patch.defaultDeviceId !== undefined) updates.defaultDeviceId = patch.defaultDeviceId;
    if (patch.agentConfig !== undefined) {
      updates.agentConfig = patch.agentConfig;
    }
    if (patch.personaStyle !== undefined) {
      // cm:why read-modify-write rather than Postgres's `jsonb || jsonb`, whose shallow merge would let a style-only patch wipe the sibling keys of the blob (`pipelineConfig`, `repoPath`, `categories`, …)
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
    // cm:guard WHOLESALE replacement and not a merge, at any depth — the semantics `previewDeploy`
    // already had and every client is written against: web-v2's Testing tab spreads the stored blob
    // before it sends, and a merge would leave no caller able to clear a field. It is the
    // `wholesale-config-clobber` affordance, kept deliberately (ISS-1069); the ONE narrow write,
    // `environmentsLimits` over MCP, stays a read-modify-write so a limits edit cannot delete the
    // credentials beside it.
    if (patch.environments !== undefined) updates.environments = patch.environments;
    if (patch.webhookSecret !== undefined) updates.webhookSecret = patch.webhookSecret;

    // cm:guard the prefix moves in the SAME transaction as the rest of the patch — it is written through a second table and its own savepoint, so applying it outside this block would leave a project renamed by a request that then failed on a sibling field and answered the caller with an error (codex review of ISS-992)
    const [updated] = await db.transaction(async (tx) => {
      if (patch.issuePrefix !== undefined) {
        await applyIssuePrefixPatch(id, patch.issuePrefix, userId, tx);
      }
      // cm:guard a patch naming ONLY `issuePrefix` leaves `updates` empty, and drizzle refuses `set({})` — the row is read back instead, because the write it asked for has already happened above
      if (Object.keys(updates).length === 0) {
        return tx.select(PATCHED_PROJECT).from(projects).where(eq(projects.id, id)).limit(1);
      }
      return tx.update(projects).set(updates).where(eq(projects.id, id)).returning(PATCHED_PROJECT);
    });
    if (!updated) throw notFound();

    // cm:guard same rule on the write door as on the read one: a PATCH that set `releaseModel: 'none'`
    // must not echo back the live branch the row still carries, or the caller writes it straight back.
    return c.json({ ...updated, liveBranch: readableLiveBranch(updated) });
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

    // cm:edge contract -> packages/core/drizzle/migrations/0219_unaudited_transition_reach.sql — `jobs`, `agent_sessions` and `pipeline_runs` all cascade off `project_id`, so this one statement deletes kernel rows and owes the `forge.kernel_txn` marker.
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

    // cm:guard `now()` here is raw SQL, never an interpolated JS `Date` — an untyped Date bind 500s against a timestamptz column; the `coalesce` is what keeps a re-archive idempotent by preserving the FIRST timestamp.
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
    if (!result.success) throw badRequest(flatten(result.error));
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
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  zValidator('json', pipelineConfigPatchSchema, (result) => {
    if (!result.success) throw badRequest(flatten(result.error));
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
      throw pipelineConfigHttpError(err);
    }
  },
);

// cm:why writable over REST since ISS-897 — `agentConfig.plugins` was reachable only through MCP `forge_config`, so an operator with a browser could read the list on the settings screen that explains what it is for and could not change it there

// cm:guard the PATCH REPLACES the whole list, and the UI must GET then send it complete. A per-entry merge would need an identity for an entry, and the only candidate — `name` — is exactly what an operator edits when they move a plugin to another marketplace.
// cm:edge contract -> packages/core/src/devices/routes.ts — `GET /api/devices/me/plugins` unions this list across every project a device serves, so a change here reaches a box on its next poll and only if that box has `[plugins] enabled`
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

    const current = await readAgentConfig(id);
    if (current === null) throw notFound();

    const next: Record<string, unknown> = { ...current };
    if (plugins === null) delete next.plugins;
    else next.plugins = plugins;

    await db.update(projects).set({ agentConfig: next }).where(eq(projects.id, id));

    return c.json({ plugins: plugins ?? [] });
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
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  async (c) => {
    const { id, issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    if (!access.role) throw forbidden('not a project member');

    const [row] = await db
      .select({
        baseBranch: projects.baseBranch,
        liveBranch: projects.liveBranch,
        releaseModel: projects.releaseModel,
      })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    if (!row) throw notFound();
    // cm:guard the branch resolver is handed the READABLE live branch, never the raw column. 25 of
    // 32 fleet projects carry a live branch nothing promotes to, and this endpoint is what the web
    // branch picker reads: handing one of those over is how a `publish` project comes to be shown,
    // and acted on, as a branch-based promote (ISS-1046).
    const project = { baseBranch: row.baseBranch, liveBranch: readableLiveBranch(row) };

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
