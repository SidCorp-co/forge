import { z } from 'zod';
import { issueStatuses, skillTargets } from '../../db/schema.js';
import { loadProjectSkillSyncStatus, resolveEffectiveSkillsForProject } from '../../skills/effective.js';
import {
  SkillDeleteBlockedError,
  createProjectSkill,
  deleteProjectSkill,
  deleteSkillOverride,
  getSkillForProject,
  listProjectSkills,
  listSkillRegistrations,
  registerSkillForProject,
  requestSkillSync,
  updateProjectSkill,
  upsertSkillOverride,
} from '../../skills/service.js';
import {
  assertDeviceOwnerIsAdmin,
  assertDeviceOwnerIsMember,
  assertPrincipalIsAdmin,
  assertPrincipalIsMember,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';
import type { ContextScopedMcpToolFactory, DeviceScopedMcpToolFactory } from './lib.js';

const listInputSchema = z.object({ projectId: z.uuid() });
const getInputSchema = z.object({ projectId: z.uuid(), skillId: z.uuid() });
const registerInputSchema = z.object({
  projectId: z.uuid(),
  skillId: z.uuid(),
  stage: z.enum(issueStatuses).nullable(),
});
const listRegistrationsInputSchema = z.object({ projectId: z.uuid() }).strict();

const skillFileMcpSchema = z
  .object({
    path: z.string().min(1).max(1024),
    content: z.string(),
    encoding: z.enum(['utf8', 'base64']).optional(),
  })
  .strict();

const createInputSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string().trim().min(1).max(128),
    description: z.string().max(2000),
    skillMd: z.string().min(1),
    target: z.enum(skillTargets).optional(),
    files: z.array(skillFileMcpSchema).optional(),
    localGuide: z.string().max(20_000).nullable().optional(),
  })
  .strict();

const updateInputSchema = z
  .object({
    projectId: z.uuid(),
    skillId: z.uuid(),
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().max(2000).optional(),
    skillMd: z.string().min(1).optional(),
    target: z.enum(skillTargets).optional(),
    files: z.array(skillFileMcpSchema).optional(),
    localGuide: z.string().max(20_000).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 2, { message: 'no fields to update' });

const overrideSetInputSchema = z
  .object({
    projectId: z.uuid(),
    skillId: z.uuid(),
    skillMdOverride: z.string().min(1).max(200_000),
    files: z.array(skillFileMcpSchema).max(500).optional(),
  })
  .strict();

const effectiveInputSchema = z.object({ projectId: z.uuid() }).strict();
const pushInputSchema = z
  .object({
    projectId: z.uuid(),
    deviceId: z.uuid().optional(),
    skillNames: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const forgeSkillsListTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_skills.list',
  description:
    'List skills visible to a project (global skills + project-scoped skills). Requires device owner to be a project member.',
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    const { projectId } = listInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, projectId);
    const skills = await listProjectSkills(projectId);
    return { skills };
  },
});

export const forgeSkillsGetTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_skills.get',
  description:
    'Fetch a single skill by id. Returns null when the skill is project-scoped to a different project (no cross-project leak).',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const { projectId, skillId } = getInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, projectId);
    const skill = await getSkillForProject(skillId, projectId);
    return { skill };
  },
});

export const forgeSkillsRegisterTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_skills.register',
  description:
    'Bind a skill to a pipeline stage for this project (or clear with stage=null). Requires device owner to be owner/admin of the project.',
  inputSchema: zodToMcpSchema(registerInputSchema),
  handler: async (args) => {
    const input = registerInputSchema.parse(args);
    await assertDeviceOwnerIsAdmin(device, input.projectId);
    const skill = await getSkillForProject(input.skillId, input.projectId);
    if (!skill) {
      throw new Error('NOT_FOUND: skill not found');
    }
    try {
      return await registerSkillForProject({ ...input, actorUserId: device.ownerId });
    } catch (err) {
      if (err instanceof SkillDeleteBlockedError) {
        throw new Error(
          `BAD_REQUEST: ${err.code}: stage '${err.stage}' has '${err.toggle}=true'. Disable the toggle in pipelineConfig before clearing the registration.`,
        );
      }
      throw err;
    }
  },
});

export const forgeSkillsListRegistrationsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skills.list_registrations',
  description:
    "List the project's stage→skill bindings overlaid with per-stage `mode` ('auto'|'manual') and `enabled` from `agentConfig.pipelineConfig.states`. Plan agents call this before dispatching to avoid sending work into a manual or disabled stage. Stages with no registration are omitted — clients diff against `STAGE_NAMES` to find gaps. Returns `{ registrations: [{ stage, skillId, skillName, scope, mode, enabled, registeredBy, registeredAt }] }`.",
  inputSchema: zodToMcpSchema(listRegistrationsInputSchema),
  handler: async (args) => {
    const { projectId } = listRegistrationsInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, projectId);
    const registrations = await listSkillRegistrations(projectId);
    return { registrations };
  },
});

export const forgeSkillsCreateTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skills.create',
  description:
    'Create a project-scoped skill (folder-first: a SKILL.md body + optional supporting files[]). Use this to load a local skill into Forge as the source of truth. Returns the created skill row (with id, version, contentHash). Requires owner/admin on the project. Global skills cannot be created here.',
  inputSchema: zodToMcpSchema(createInputSchema),
  handler: async (args) => {
    const input = createInputSchema.parse(args);
    await assertPrincipalIsAdmin(ctx.principal, input.projectId);
    const skill = await createProjectSkill({
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      skillMd: input.skillMd,
      target: input.target ?? null,
      files: input.files,
      localGuide: input.localGuide ?? null,
    });
    return { skill };
  },
});

export const forgeSkillsUpdateTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skills.update',
  description:
    'Update a project-scoped skill (name/description/skillMd/target/files/localGuide). Bumps version + recomputes contentHash when the body or files change. Requires owner/admin. Global skills cannot be updated here (use override_set to fork a global for this project).',
  inputSchema: zodToMcpSchema(updateInputSchema),
  handler: async (args) => {
    const { projectId, skillId, ...patch } = updateInputSchema.parse(args);
    await assertPrincipalIsAdmin(ctx.principal, projectId);
    const row = await getSkillForProject(skillId, projectId);
    if (!row) throw new Error('NOT_FOUND: skill not found');
    if (row.scope !== 'project') {
      throw new Error('BAD_REQUEST: only project-scoped skills can be updated; use override_set for globals');
    }
    const skill = await updateProjectSkill(row, { ...patch, target: patch.target ?? undefined });
    return { skill };
  },
});

export const forgeSkillsDeleteTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skills.delete',
  description:
    'Delete a project-scoped skill. Requires owner/admin. Global skills cannot be deleted here.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const { projectId, skillId } = getInputSchema.parse(args);
    await assertPrincipalIsAdmin(ctx.principal, projectId);
    const row = await getSkillForProject(skillId, projectId);
    if (!row) throw new Error('NOT_FOUND: skill not found');
    if (row.scope !== 'project') throw new Error('BAD_REQUEST: global skills cannot be deleted here');
    await deleteProjectSkill(skillId);
    return { deleted: true, skillId };
  },
});

export const forgeSkillsEffectiveTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skills.effective',
  description:
    "The project's effective skills — every global skill with this project's overrides merged in, plus project-scoped skills. Each row carries the resolved skillMd, files, effectiveHash, and isOverridden. This is exactly what a device installs on sync. Requires project membership.",
  inputSchema: zodToMcpSchema(effectiveInputSchema),
  handler: async (args) => {
    const { projectId } = effectiveInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, projectId);
    const skills = await resolveEffectiveSkillsForProject(projectId);
    return { skills };
  },
});

export const forgeSkillsSyncStatusTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skills.sync_status',
  description:
    'Per-device skill freshness for the project: for each device-bound runner and each registered skill, whether it is synced / outdated / missing (server effectiveHash vs the device-reported installedHash) plus syncedAt. Use after a push to verify a device picked up the new skills. Requires project membership.',
  inputSchema: zodToMcpSchema(effectiveInputSchema),
  handler: async (args) => {
    const { projectId } = effectiveInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, projectId);
    const status = await loadProjectSkillSyncStatus(projectId);
    return status;
  },
});

export const forgeSkillsOverrideSetTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skills.override_set',
  description:
    "Fork a GLOBAL skill for this project (full-folder override): replaces the global skillMd + files for this project only. Omit files to fork the global folder as the starting point. Requires owner/admin. Use forge_skills.create instead for a brand-new project skill.",
  inputSchema: zodToMcpSchema(overrideSetInputSchema),
  handler: async (args) => {
    const input = overrideSetInputSchema.parse(args);
    await assertPrincipalIsAdmin(ctx.principal, input.projectId);
    const skill = await getSkillForProject(input.skillId, input.projectId);
    if (!skill) throw new Error('NOT_FOUND: skill not found');
    if (skill.scope !== 'global') {
      throw new Error('BAD_REQUEST: override target must be a global skill');
    }
    const override = await upsertSkillOverride({
      projectId: input.projectId,
      skill,
      skillMdOverride: input.skillMdOverride,
      files: input.files,
      actorUserId: principalUserId(ctx.principal),
    });
    return { override };
  },
});

export const forgeSkillsOverrideDeleteTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skills.override_delete',
  description:
    'Remove this project\'s override of a global skill (revert to the global body). Requires owner/admin.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const { projectId, skillId } = getInputSchema.parse(args);
    await assertPrincipalIsAdmin(ctx.principal, projectId);
    const skill = await getSkillForProject(skillId, projectId);
    if (!skill) throw new Error('NOT_FOUND: skill not found');
    if (skill.scope !== 'global') throw new Error('BAD_REQUEST: not a global skill');
    const deleted = await deleteSkillOverride({
      projectId,
      skill,
      actorUserId: principalUserId(ctx.principal),
    });
    if (!deleted) throw new Error('NOT_FOUND: override not found');
    return { deleted: true, skillId };
  },
});

export const forgeSkillsPushTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skills.push',
  description:
    "Push (sync) the project's skills to its device-bound runners. Sends a `skill.sync` command over WebSocket to each targeted device room; the device pulls its effective manifest and reports installed hashes back — bodies are NOT sent in this call. Omit deviceId to signal every device-bound runner of the project, or pass one deviceId to target a single device. skillNames is an optional hint. Returns the deviceIds signalled (empty if the project has no device-bound runner). Requires owner/admin. This is the only programmatic way to trigger a device sync — there is no background auto-sync.",
  inputSchema: zodToMcpSchema(pushInputSchema),
  handler: async (args) => {
    const input = pushInputSchema.parse(args);
    await assertPrincipalIsAdmin(ctx.principal, input.projectId);
    const result = await requestSkillSync({
      projectId: input.projectId,
      actorUserId: principalUserId(ctx.principal),
      skillNames: input.skillNames ?? null,
      deviceId: input.deviceId,
    });
    return result;
  },
});
