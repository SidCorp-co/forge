import { z } from 'zod';
import { issueStatuses } from '../../db/schema.js';
import {
  SkillDeleteBlockedError,
  getSkillForProject,
  listProjectSkills,
  listSkillRegistrations,
  registerSkillForProject,
} from '../../skills/service.js';
import {
  assertDeviceOwnerIsAdmin,
  assertDeviceOwnerIsMember,
  assertPrincipalIsMember,
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
