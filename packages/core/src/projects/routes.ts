import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  assertUnfenced,
  loadProjectAccess,
  maxProjectRole,
  orgDerivedProjectRole,
} from '../lib/authz.js';
import { pluginDesignationsPatchSchema } from '../lib/plugin-designation.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema, notFound } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { findPersonalOrgId } from '../orgs/index.js';
import {
  actorFor,
  orgResource,
  requireHeld,
  requireOrgCan,
  requireOrgHeld,
} from '../permissions/index.js';
import { readDeclaredSource } from '../project-config/index.js';
import { patchAgentConfigKeys, readAgentConfig } from './agent-config.js';
import { listVisibleProjectRows, projectDetail } from './read.js';
import { createProjectBodySchema, updateProjectPatchSchema } from './request-schemas.js';
import {
  archiveProject,
  createProject,
  deleteProject,
  unarchiveProject,
  updateProjectSettings,
} from './service.js';

export const projectRoutes = new Hono<{ Variables: AuthVars }>();

projectRoutes.use('*', requireAuth(), assertEmailVerified());

projectRoutes.post('/', zValidator('json', createProjectBodySchema), async (c) => {
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
});

const listQuery = zValidator(
  'query',
  z.object({ archived: z.string().optional() }),
  invalid('archived takes one value: 1 or true lists archived projects too'),
);

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

projectRoutes.get('/:id', zValidator('param', idParamSchema), async (c) => {
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
});

projectRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema),
  zValidator('json', updateProjectPatchSchema),
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

    const updated = await updateProjectSettings(id, userId, {
      orgId,
      issuePrefix: patch.issuePrefix,
    });
    if (!updated) throw notFound();

    return c.json(updated);
  },
);

projectRoutes.delete('/:id', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  const access = await loadProjectAccess(id, userId);
  requireOrgHeld(access.orgId, access.orgRole, 'org.admin');

  await deleteProject(id);
  return c.body(null, 204);
});

// ─── Soft archive / unarchive (ISS-353) ──────────────────────────────────────
//
// Owner-only, mirroring the gate on PATCH/DELETE /:id. Archive sets
// `archived_at` to the DB clock; unarchive clears it. Both are idempotent and
// non-destructive — no project-owned data (issues, comments, runs, sessions)
// is touched. Archived projects drop out of the default GET / list and stop
// dispatching new auto-pipeline jobs (see orchestrator.loadProjectPolicy);
// in-flight jobs are unaffected. The hard DELETE /:id route above is unchanged.

projectRoutes.post('/:id/archive', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  const access = await loadProjectAccess(id, userId);
  requireOrgHeld(access.orgId, access.orgRole, 'org.admin');

  const updated = await archiveProject(id);
  if (!updated) throw notFound();
  return c.json(updated);
});

projectRoutes.post('/:id/unarchive', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  const access = await loadProjectAccess(id, userId);
  requireOrgHeld(access.orgId, access.orgRole, 'org.admin');

  const updated = await unarchiveProject(id);
  if (!updated) throw notFound();
  return c.json(updated);
});

projectRoutes.patch(
  '/:id/plugins',
  zValidator('param', idParamSchema),
  zValidator('json', z.object({ plugins: pluginDesignationsPatchSchema })),
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

export { invitationRoutes } from './invitations-routes.js';
export { masterCharterRoutes } from './master-charter-routes.js';
export { memberRoutes } from './members-routes.js';
