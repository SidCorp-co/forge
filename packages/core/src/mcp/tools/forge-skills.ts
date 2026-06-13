import { z } from 'zod';
import { issueStatuses, skillTargets } from '../../db/schema.js';
import { loadProjectSkillSyncStatus, resolveEffectiveSkillsForProject } from '../../skills/effective.js';
import {
  SkillAlreadyShadowedError,
  SkillDeleteBlockedError,
  SkillNotProjectScopedError,
  type SkillRow,
  applyGlobalSkillDefault,
  createProjectSkill,
  deleteProjectSkill,
  getSkillForProject,
  listProjectSkills,
  listSkillRegistrations,
  registerSkillForProject,
  requestSkillSync,
  updateProjectSkill,
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

const effectiveInputSchema = z.object({ projectId: z.uuid() }).strict();
const adoptInputSchema = z.object({ projectId: z.uuid(), skillId: z.uuid() }).strict();
const pushInputSchema = z
  .object({
    projectId: z.uuid(),
    deviceId: z.uuid().optional(),
    skillNames: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** Skill row with the shadow marker added by the agent-facing dedup. */
type SkillListRow = SkillRow & {
  shadowsGlobal: boolean;
  shadowedGlobalSkillId: string | null;
};

/**
 * Dedup the project-visible skills by NAME: a project-scoped skill shadows the
 * same-name global template (project wins, one row per name). Returns one row
 * per name with a `shadowsGlobal` marker so the agent knows which skill body
 * actually applies. Keeps the underlying REST crud GET untouched — only this
 * agent-facing surface dedups.
 */
function dedupSkillsByName(rows: SkillRow[]): SkillListRow[] {
  const globalByName = new Map<string, SkillRow>();
  for (const r of rows) if (r.scope === 'global') globalByName.set(r.name, r);

  const out: SkillListRow[] = [];
  const shadowedNames = new Set<string>();
  for (const r of rows) {
    if (r.scope !== 'project') continue;
    shadowedNames.add(r.name);
    const shadowed = globalByName.get(r.name);
    out.push({
      ...r,
      shadowsGlobal: shadowed != null,
      shadowedGlobalSkillId: shadowed?.id ?? null,
    });
  }
  for (const r of rows) {
    if (r.scope !== 'global') continue;
    if (shadowedNames.has(r.name)) continue;
    out.push({ ...r, shadowsGlobal: false, shadowedGlobalSkillId: null });
  }
  return out;
}

/**
 * ISS-428 — body-free projection for the `list` (catalog) surface. Drops the
 * heavy fields (`skillMd` body, `prompt`, `files`, `tools`, `manifest`,
 * `changelog`, `localGuide`) that blow the MCP token cap; keeps the catalog
 * metadata + dedup hints. Bodies stay reachable via forge_skills.get /
 * forge_skills.effective.
 */
function toSkillListRow(row: SkillListRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    projectId: row.projectId,
    version: row.version,
    contentHash: row.contentHash,
    target: row.target,
    evalScore: row.evalScore,
    shadowsGlobal: row.shadowsGlobal,
    shadowedGlobalSkillId: row.shadowedGlobalSkillId,
  };
}

export const forgeSkillsListTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_skills.list',
  description:
    'Catalog of skills visible to a project, deduped by name. Returns a lightweight projection per skill (catalog metadata + dedup hints); the heavy bodies (skillMd, prompt, files, tools, manifest, changelog, localGuide) are OMITTED to stay under the response token cap — fetch a skill body via forge_skills.get / forge_skills.effective. Each row has `scope`: `project` rows are USABLE (installable/dispatchable); `global` rows are adoptable TEMPLATES that do nothing at runtime until adopted (forge_skills.adopt) into the project. `shadowsGlobal`/`shadowedGlobalSkillId` are catalog hints (a same-name global exists), never a runtime fallback. Requires device owner to be a project member.',
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    const { projectId } = listInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, projectId);
    const skills = dedupSkillsByName(await listProjectSkills(projectId)).map(toSkillListRow);
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
    'Bind a PROJECT skill to a pipeline stage for this project (or clear with stage=null). Only project-scoped skills may be registered — a global template must be adopted (forge_skills.adopt) into the project first, else this rejects with SKILL_NOT_PROJECT_SCOPED. Requires device owner to be owner/admin of the project.',
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
      if (err instanceof SkillNotProjectScopedError) {
        throw new Error(
          `BAD_REQUEST: ${err.code}: only a project skill may be registered. Adopt the global template into this project first (forge_skills.adopt), then register the resulting project skill.`,
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
    'Update a project-scoped skill (name/description/skillMd/target/files/localGuide). Bumps version + recomputes contentHash when the body or files change. Requires owner/admin. Global skills are immutable templates and cannot be updated; create a same-name project skill to shadow one for this project.',
  inputSchema: zodToMcpSchema(updateInputSchema),
  handler: async (args) => {
    const { projectId, skillId, ...patch } = updateInputSchema.parse(args);
    await assertPrincipalIsAdmin(ctx.principal, projectId);
    const row = await getSkillForProject(skillId, projectId);
    if (!row) throw new Error('NOT_FOUND: skill not found');
    if (row.scope !== 'project') {
      throw new Error('BAD_REQUEST: global skills are immutable templates; create a same-name project skill to shadow one');
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
    "The project's CATALOG — deduped by name: project skills (scope='project', USABLE) plus global TEMPLATES (scope='global', adoptable, NOT usable). Each row carries skillMd, files, effectiveHash, scope, and shadowsGlobal/shadowedGlobalSkillId (catalog hints only). NOTE: this is NOT what a device installs — only the registered ∩ project subset is installed/dispatched (see forge_skills.sync_status). A global row here runs nowhere until adopted (forge_skills.adopt). Requires project membership.",
  inputSchema: zodToMcpSchema(effectiveInputSchema),
  handler: async (args) => {
    const { projectId } = effectiveInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, projectId);
    const skills = await resolveEffectiveSkillsForProject(projectId);
    return { skills };
  },
});

export const forgeSkillsAdoptTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_skills.adopt',
  description:
    'Adopt a global skill TEMPLATE into this project: clones the global (skillId must be a global) into a new project-scoped skill of the same name, which the project then owns and can edit + register. This is the ONLY way a global enters a project at runtime (globals never install/dispatch directly). Rejects with ALREADY_SHADOWED if a same-name project skill already exists. Requires owner/admin on the project. Returns the created project skill.',
  inputSchema: zodToMcpSchema(adoptInputSchema),
  handler: async (args) => {
    const { projectId, skillId } = adoptInputSchema.parse(args);
    await assertPrincipalIsAdmin(ctx.principal, projectId);
    const global = await getSkillForProject(skillId, projectId);
    if (!global) throw new Error('NOT_FOUND: skill not found');
    if (global.scope !== 'global') {
      throw new Error('BAD_REQUEST: skillId must be a global template to adopt');
    }
    try {
      const skill = await applyGlobalSkillDefault({
        projectId,
        global: {
          name: global.name,
          description: global.description,
          skillMd: global.skillMd,
          prompt: global.prompt,
          target: global.target,
          files: global.files,
        },
      });
      return { skill };
    } catch (err) {
      if (err instanceof SkillAlreadyShadowedError) {
        throw new Error(`BAD_REQUEST: ${err.code}: ${err.message}`);
      }
      throw err;
    }
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
