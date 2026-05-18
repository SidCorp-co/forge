import { count, eq, ilike, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { projectMembers, projects, users } from '../../db/schema.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalCanAdmin,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['list']),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const forgeAdminUsersTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_admin_users',
  description:
    "Cross-tenant user list with membership matrix. Requires system admin (`users.isCeo=true`) AND PAT scope `admin` (device tokens are exempt). Read-only in v1. Action: `list` (optional `search` matches email prefix; paginated). Each user includes `memberships: [{ projectId, projectSlug, role }]`. Never returns passwordHash or any auth secret.",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    await assertPrincipalCanAdmin(ctx.principal);

    const whereClause = input.search
      ? ilike(users.email, `${input.search.replace(/[%_]/g, '\\$&')}%`)
      : undefined;

    const [totalRow] = await db
      .select({ total: count() })
      .from(users)
      .where(whereClause);
    const total = Number(totalRow?.total ?? 0);

    const userRows = await db
      .select({
        id: users.id,
        email: users.email,
        isCeo: users.isCeo,
        emailVerifiedAt: users.emailVerifiedAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(whereClause)
      .orderBy(users.createdAt, users.id)
      .limit(limit)
      .offset(offset);

    if (userRows.length === 0) {
      return { users: [], total };
    }

    const ids = userRows.map((u) => u.id);
    const memberRows = await db
      .select({
        userId: projectMembers.userId,
        projectId: projectMembers.projectId,
        projectSlug: projects.slug,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(inArray(projectMembers.userId, ids));

    const byUser = new Map<
      string,
      Array<{ projectId: string; projectSlug: string; role: string }>
    >();
    for (const m of memberRows) {
      const list = byUser.get(m.userId) ?? [];
      list.push({ projectId: m.projectId, projectSlug: m.projectSlug, role: m.role });
      byUser.set(m.userId, list);
    }

    const out = userRows.map((u) => ({
      id: u.id,
      email: u.email,
      isCeo: u.isCeo,
      emailVerifiedAt: u.emailVerifiedAt,
      createdAt: u.createdAt,
      memberships: byUser.get(u.id) ?? [],
    }));

    return { users: out, total };
  },
});
