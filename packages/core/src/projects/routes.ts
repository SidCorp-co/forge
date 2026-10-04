import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { extractIssueBranchOverride, resolveIssueBranches } from '../branches/resolve.js';
import {
  assertUnfenced,
  loadProjectAccess,
  maxProjectRole,
  orgDerivedProjectRole,
} from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { findPersonalOrgId } from '../orgs/service.js';
import { actorFor, orgResource, requireHeld, requireOrgCan, requireOrgHeld } from '../permissions/index.js';
import { pluginDesignationsPatchSchema } from '../plugins/designation.js';
import { readDeclaredSource } from '../project-config/source.js';
import { type AgentConfigKeyPatch, patchAgentConfigKeys, readAgentConfig } from './agent-config.js';
import { projectOnboardRoutes } from './onboard-routes.js';
import { projectFactsRoutes } from './project-facts-routes.js';
import { listVisibleProjectRows, projectDetail } from './read.js';
import { createProjectBodySchema, updateProjectPatchSchema } from './request-schemas.js';
import { projectRunnerRoutes } from './runners-routes.js';
import {
  archiveProject,
  createProject,
  deleteProject,
  readIssueBranchInputs,
  readProjectBranches,
  unarchiveProject,
  updateProjectSettings,
} from './service.js';

export const projectRoutes = new Hono<{ Variables: AuthVars }>();

projectRoutes.use('*', requireAuth(), assertEmailVerified());

projectRoutes.post(
  '/',
  zValidator('json', createProjectBodySchema, (result) => {
    if (!result.success) {
      throw badRequest(result.error);
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
      await requireOrgCan(actorFor(userId), 'org.read', orgResource(requestedOrgId));
      orgId = requestedOrgId;
    } else {
      const personal = await findPersonalOrgId(userId);
      if (!personal) {
        throw new HTTPException(500, {
          message: 'personal org missing — run migrations',
          cause: { code: 'PERSONAL_ORG_MISSING' },
        });
      }
      orgId = personal;
    }

    const created = await createProject({
      slug,
      name,
      orgId,
      createdBy: userId,
    });
    return c.json(created, 201);
  },
);

const listQuery = zValidator('query', z.object({ archived: z.string().optional() }), (result) => {
  if (!result.success) {
    throw new HTTPException(400, {
      message: 'archived takes one value: 1 or true lists archived projects too',
      cause: { code: 'BAD_REQUEST' },
    });
  }
});

projectRoutes.get('/', listQuery, async (c) => {
  const userId = c.get('userId');
  const archived = c.req.valid('query').archived ?? '';
  const includeArchived = ['1', 'true'].includes(archived.toLowerCase());
  // Visible = explicit membership (any role) OR org owner/admin on the
  // project's org (implicit admin) — same rule as lib/authz.ts.
  const rows = await listVisibleProjectRows(userId, includeArchived);

  return c.json(
    rows.map(({ memberRole, orgRole, ...row }) => {
      const role = maxProjectRole(memberRole ?? null, orgDerivedProjectRole(orgRole ?? null));
      return {
        ...row,
        role,
        orgRole: orgRole ?? null,
      };
    }),
  );
});

projectRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    requireHeld(access, 'project.read');

    const detail = await projectDetail(id);
    if (!detail) throw notFound();

    return c.json({
      ...detail.project,
      baseBranch: (await readDeclaredSource(id)).defaultBranch,
      role: access.role,
      orgRole: access.orgRole,
      members: detail.members,
      labels: detail.labels,
      devicePool: detail.devicePool,
    });
  },
);

projectRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', updateProjectPatchSchema, (result) => {
    if (result.success) return;
    throw badRequest(result.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    // Settings PATCH keeps the legacy owner-only strictness: org owner/admin,
    // not a merely-invited project admin.
    const access = await loadProjectAccess(id, userId);
    requireOrgHeld(access.orgId, access.orgRole, 'org.admin');

    let orgId: string | undefined;
    if (patch.orgId !== undefined && patch.orgId !== access.orgId) {
      await requireOrgCan(actorFor(userId), 'org.admin', orgResource(patch.orgId));
      orgId = patch.orgId;
    }

    const agentConfigPatch: AgentConfigKeyPatch = {};
    if (patch.assistantWeekly !== undefined)
      agentConfigPatch.assistantWeekly = patch.assistantWeekly;

    const updated = await updateProjectSettings(id, userId, {
      orgId,
      agentConfig: agentConfigPatch,
      issuePrefix: patch.issuePrefix,
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
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    requireOrgHeld(access.orgId, access.orgRole, 'org.admin');

    await deleteProject(id);
    return c.body(null, 204);
  },
);

// ─── Soft archive / unarchive (ISS-353) ──────────────────────────────────────
//
// Owner-only, mirroring the gate on PATCH/DELETE /:id. Archive sets
// `archived_at` to the DB clock; unarchive clears it. Both are idempotent and
// non-destructive — no project-owned data (issues, comments, runs, sessions)
// is touched. Archived projects drop out of the default GET / list and stop
// dispatching new auto-pipeline jobs (see orchestrator.loadProjectPolicy);
// in-flight jobs are unaffected. The hard DELETE /:id route above is unchanged.

projectRoutes.post(
  '/:id/archive',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    requireOrgHeld(access.orgId, access.orgRole, 'org.admin');

    const updated = await archiveProject(id);
    if (!updated) throw notFound();
    return c.json(updated);
  },
);

projectRoutes.post(
  '/:id/unarchive',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    requireOrgHeld(access.orgId, access.orgRole, 'org.admin');

    const updated = await unarchiveProject(id);
    if (!updated) throw notFound();
    return c.json(updated);
  },
);

projectRoutes.patch(
  '/:id/plugins',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', z.object({ plugins: pluginDesignationsPatchSchema }), (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { plugins } = c.req.valid('json');
    const access = await loadProjectAccess(id, c.get('userId'));
    requireOrgHeld(access.orgId, access.orgRole, 'org.admin');

    if ((await readAgentConfig(id)) === null) throw notFound();
    await patchAgentConfigKeys(id, { plugins });

    return c.json({ plugins: plugins ?? [] });
  },
);

projectRoutes.route('/', projectFactsRoutes);

// ─── Branch config (ISS-135 PR-A) ───────────────────────────────────────────
//
// Resolved branch config for one issue: the per-issue override, read by
// `extractIssueBranchOverride`, layered on the
// project defaults. The endpoint returns the *resolved* shape only.

const branchConfigParamSchema = z.object({
  id: z.uuid(),
  issueId: z.uuid(),
});

projectRoutes.get(
  '/:id/issues/:issueId/branch-config',
  zValidator('param', branchConfigParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id, issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    requireHeld(access, 'project.read');

    const project = await readProjectBranches(id);
    if (!project) throw notFound();

    const issueRow = await readIssueBranchInputs(issueId, id);
    if (!issueRow) {
      throw new HTTPException(404, {
        message: 'issue not found',
        cause: { code: 'NOT_FOUND' },
      });
    }

    const resolved = resolveIssueBranches(
      {
        metadata: {
          branchConfig: extractIssueBranchOverride(
            issueRow as Parameters<typeof extractIssueBranchOverride>[0],
          ),
        },
      },
      project,
    );

    return c.json(resolved);
  },
);

// ISS-733 — POST /:id/onboard. The "Build Project Brain" trigger; the thin
// HTTP delegate lives in ./onboard-routes.ts.
projectRoutes.route('/', projectOnboardRoutes);

export { collaboratorsMeRoutes } from './collaborators-routes.js';
export { gitCredentialRoutes } from './git-credential-routes.js';
export { projectHealthRoutes } from './health-routes.js';
export { invitationRoutes } from './invitations-routes.js';
export { masterCharterRoutes } from './master-charter-routes.js';
export { memberRoutes } from './members-routes.js';
