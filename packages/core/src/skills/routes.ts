import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { issueStatuses } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { isMetaSkillName, metaSkillReserved } from './meta-skills.js';
import { listSkillRegistrations, registeredSkillIdAt } from './read.js';
import { registerSkillForProject } from './registration-service.js';
import { getSkillForProject, syncProjectSkillManifests } from './service.js';

const projectParamSchema = z.object({ projectId: z.uuid() });
const skillParamSchema = z.object({ projectId: z.uuid(), skillId: z.uuid() });
const stageParamSchema = z.object({ projectId: z.uuid(), stage: z.enum(issueStatuses) });

const syncManifestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2000).optional(),
  prompt: z.string().min(1),
  tools: z.array(z.string()).default([]),
  version: z.string().max(32).optional(),
  hash: z.string().min(8).max(128),
});

const syncBodySchema = z
  .object({
    mode: z.enum(['partial', 'full']).default('partial'),
    skills: z.array(syncManifestSchema).min(0).max(500),
  })
  .refine((b) => new Set(b.skills.map((s) => s.name)).size === b.skills.length, {
    message: 'duplicate skill names in payload',
  });

const registerBodySchema = z.object({
  stage: z.enum(issueStatuses).nullable(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

const notFound = (code = 'NOT_FOUND', message = 'not found') =>
  new HTTPException(404, { message, cause: { code } });

async function requireDeviceSync(
  deviceOwnerId: string,
  projectId: string,
  mode: string,
): Promise<void> {
  const access = await loadProjectAccess(projectId, deviceOwnerId);
  requireHeld(access, mode === 'full' ? 'project.admin' : 'project.read', `A ${mode} skill sync`);
}

export const skillSyncRoutes = new Hono<{ Variables: DeviceVars }>();
skillSyncRoutes.use('/:projectId/skills/sync', requireDevice());
skillSyncRoutes.post(
  '/:projectId/skills/sync',
  zValidator('param', projectParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', syncBodySchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    const device = c.get('device');

    await requireDeviceSync(device.ownerId, projectId, body.mode);

    // Meta skills (plugin channel) are Forge-owned and non-overridable — a
    // device must never author/overwrite one via this manifest push. The
    // user-token CRUD/adopt/register paths funnel through the service guard
    // (`createProjectSkill`); this device-token path writes `skills` directly,
    // so it must enforce the same reservation here (ISS-741 / task 703cc186).
    const reserved = body.skills.find((s) => isMetaSkillName(s.name));
    if (reserved) throw metaSkillReserved(reserved.name);

    // One transaction reads the baseline, categorises and upserts; the partial-unique index
    // (project_id, name) WHERE scope='project' collapses an insert race into an update.
    const { diff, added, updated } = await syncProjectSkillManifests(
      projectId,
      body.mode,
      body.skills,
    );

    return c.json({ added, updated, unchanged: diff.unchanged, removed: diff.toRemove });
  },
);

export const skillRegisterRoutes = new Hono<{ Variables: AuthVars }>();
skillRegisterRoutes.use(
  '/:projectId/skills/:skillId/register',
  requireAuth(),
  assertEmailVerified(),
);
skillRegisterRoutes.post(
  '/:projectId/skills/:skillId/register',
  zValidator('param', skillParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', registerBodySchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { projectId, skillId } = c.req.valid('param');
    const { stage } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    const skill = await getSkillForProject(skillId, projectId);
    if (!skill) throw notFound('NOT_FOUND', 'skill not found');

    const result = await registerSkillForProject({
      projectId,
      skillId,
      stage,
      actorUserId: userId,
    });
    return c.json(result);
  },
);

// ISS-109 — list current per-stage skill bindings for a project. Read access
// is project membership; the skill registrations themselves contain no
// privileged data.
skillRegisterRoutes.use('/:projectId/skill-registrations', requireAuth(), assertEmailVerified());
skillRegisterRoutes.get(
  '/:projectId/skill-registrations',
  zValidator('param', projectParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const rows = await listSkillRegistrations(projectId);
    return c.json({ registrations: rows });
  },
);

// ISS-109 — clear the skill binding for a single stage by stage key, without
// the caller having to remember which skill is currently registered. Reuses
// `registerSkillForProject({ stage: null })` so the hook side-effect fires
// once with the correct skillId.
skillRegisterRoutes.use(
  '/:projectId/skills/registrations/:stage',
  requireAuth(),
  assertEmailVerified(),
);
skillRegisterRoutes.delete(
  '/:projectId/skills/registrations/:stage',
  zValidator('param', stageParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { projectId, stage } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    const registeredSkillId = await registeredSkillIdAt(projectId, stage);
    if (!registeredSkillId) return c.json({ deleted: false, stage });

    await registerSkillForProject({
      projectId,
      skillId: registeredSkillId,
      stage: null,
      actorUserId: userId,
    });
    return c.json({ deleted: true, stage });
  },
);

export { skillActivityRoutes } from './activity-routes.js';
export { skillCrudRoutes } from './crud-routes.js';
export { divergenceCharterRoutes } from './divergence-charter-routes.js';
export { projectOnboardRoutes } from './onboard-routes.js';
export { skillPinRoutes } from './pin-routes.js';
export { reconcileRoutes } from './reconcile-routes.js';
export { skillSmokeVerifyRoutes } from './smoke-verify-routes.js';
export { skillStudioRoutes } from './studio-routes.js';
