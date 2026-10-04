import { z } from 'zod';
import { listOrgMembers, listOrgsForUser } from '../../orgs/service.js';
import { type ContextScopedMcpToolFactory, principalUserId, zodToMcpSchema } from './lib.js';
import { requireOrgCan } from '../../permissions/index.js';

const listInputSchema = z.object({}).strict();

export const forgeOrgsListTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_orgs.list',
  reach: { account: 'listing the organizations its owner belongs to' },
  route: '/api/orgs',
  grant: 'orgs:read',
  description:
    "List organizations the calling principal belongs to, with the caller's org role (owner|admin|member) and the isPersonal flag. Use the id as `orgId` for forge_projects.create or org-owned integration connections. Org management (create/members) lives on REST /api/orgs.",
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    listInputSchema.parse(args);
    const userId = principalUserId(ctx.principal);
    return { orgs: await listOrgsForUser(userId) };
  },
});

const membersInputSchema = z.object({ orgId: z.uuid() }).strict();

export const forgeOrgsMembersTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_orgs.members',
  reach: { account: "reading an organization's members" },
  route: '/api/orgs',
  grant: 'orgs:read',
  description:
    'List the members of an org the calling principal belongs to (userId, email, role, createdAt). Non-members read NOT_FOUND.',
  inputSchema: zodToMcpSchema(membersInputSchema),
  handler: async (args) => {
    const input = membersInputSchema.parse(args);
    const userId = principalUserId(ctx.principal);
    await requireOrgCan({ userId }, 'org.read', input.orgId);
    return { members: await listOrgMembers(input.orgId) };
  },
});
