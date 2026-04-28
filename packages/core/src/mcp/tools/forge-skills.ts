import { z } from 'zod';
import { issueStatuses } from '../../db/schema.js';
import {
  getSkillForProject,
  listProjectSkills,
  registerSkillForProject,
} from '../../skills/service.js';
import { assertDeviceOwnerIsAdmin, assertDeviceOwnerIsMember, zodToMcpSchema } from './lib.js';
import type { DeviceScopedMcpToolFactory } from './lib.js';

const listInputSchema = z.object({ projectId: z.uuid() });
const getInputSchema = z.object({ projectId: z.uuid(), skillId: z.uuid() });
const registerInputSchema = z.object({
  projectId: z.uuid(),
  skillId: z.uuid(),
  stage: z.enum(issueStatuses).nullable(),
});

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
    return registerSkillForProject({ ...input, actorUserId: device.ownerId });
  },
});
