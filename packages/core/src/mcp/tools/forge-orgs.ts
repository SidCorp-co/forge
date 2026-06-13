import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { organizationMembers, organizations, users } from '../../db/schema.js';
import { loadOrgRole } from '../../lib/authz.js';
import { type ContextScopedMcpToolFactory, principalUserId, zodToMcpSchema } from './lib.js';

/**
 * Org-tier read surface over MCP. Orgs own projects (projects.orgId) and can
 * own integration connections (ownerType='org'); org owner/admin hold
 * implicit project admin on every project of the org. Management (create,
 * members CRUD) stays on REST `/api/orgs` — agents only need to discover
 * which org to target (e.g. `forge_projects.create { orgId }`).
 */

const listInputSchema = z.object({}).strict();

export const forgeOrgsListTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_orgs.list',
  description:
    "List organizations the calling principal belongs to, with the caller's org role (owner|admin|member) and the isPersonal flag. Use the id as `orgId` for forge_projects.create or org-owned integration connections. Org management (create/members) lives on REST /api/orgs.",
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    listInputSchema.parse(args);
    const userId = principalUserId(ctx.principal);
    const rows = await db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
        isPersonal: organizations.isPersonal,
        role: organizationMembers.role,
        createdAt: organizations.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(eq(organizationMembers.userId, userId));
    return { orgs: rows };
  },
});

const membersInputSchema = z.object({ orgId: z.uuid() }).strict();

export const forgeOrgsMembersTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_orgs.members',
  description:
    'List the members of an org the calling principal belongs to (userId, email, role, createdAt). Non-members read NOT_FOUND.',
  inputSchema: zodToMcpSchema(membersInputSchema),
  handler: async (args) => {
    const input = membersInputSchema.parse(args);
    const userId = principalUserId(ctx.principal);
    const role = await loadOrgRole(input.orgId, userId);
    if (!role) throw new Error('NOT_FOUND: org not found or not accessible');
    const rows = await db
      .select({
        userId: organizationMembers.userId,
        email: users.email,
        role: organizationMembers.role,
        createdAt: organizationMembers.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, input.orgId));
    return { members: rows };
  },
});
