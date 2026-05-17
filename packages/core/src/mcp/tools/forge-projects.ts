import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  type ProjectMemberRole,
  projectMembers,
  projects,
  users,
} from '../../db/schema.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from './lib.js';

/**
 * MCP Phase 1 (ISS-7) — enumerate projects visible to the device's owner.
 * Visibility logic mirrors the cross-project fan-out used in
 * `packages/core/src/agent-sessions/routes.ts` (~line 705) and
 * `projects/health-routes.ts`: CEO sees all; everyone else sees owned plus
 * member projects. Pre-req for ISS-9 (cross-project dispatch).
 *
 * Role values follow the `projectMemberRoles` enum (`owner | admin | member`)
 * — the issue spec called the third tier `contributor`, but the schema is
 * authoritative.
 */

const inputSchema = z.object({}).strict();

type ListedProject = {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
  role: 'owner' | ProjectMemberRole;
};

export const forgeProjectsListTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects.list',
  description:
    'List projects visible to the principal (owned + member; CEO sees all). For PAT principals, results are additionally narrowed to the token\'s projectIds allowlist when set. Returns id, slug, name, ownerId, role.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    inputSchema.parse(args);
    const { principal } = ctx;
    const userId =
      principal.kind === 'device' ? principal.device.ownerId : principal.userId;
    const patAllowlist =
      principal.kind === 'pat' && principal.projectIds !== null
        ? new Set(principal.projectIds)
        : null;

    const [me] = await db
      .select({ id: users.id, isCeo: users.isCeo })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (me?.isCeo) {
      const rows = await db
        .select({
          id: projects.id,
          slug: projects.slug,
          name: projects.name,
          ownerId: projects.ownerId,
        })
        .from(projects);
      const out: ListedProject[] = rows.map((r) => ({
        ...r,
        role: r.ownerId === userId ? 'owner' : 'admin',
      }));
      const narrowed = patAllowlist ? out.filter((r) => patAllowlist.has(r.id)) : out;
      return { projects: narrowed };
    }

    // Two separate queries instead of a left-join + selectDistinct: the join
    // approach inflates rows for owned projects that have multiple members
    // (every member row passes the WHERE because `projects.ownerId = userId`
    // is true), and `memberRole` in the distinct key prevents dedup. Two
    // queries + a Map dedupe is cleaner and matches REST behaviour.
    const ownedRows = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        ownerId: projects.ownerId,
      })
      .from(projects)
      .where(eq(projects.ownerId, userId));

    const memberRows = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        ownerId: projects.ownerId,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(eq(projectMembers.userId, userId));

    const byId = new Map<string, ListedProject>();
    for (const r of ownedRows) {
      byId.set(r.id, { ...r, role: 'owner' });
    }
    for (const r of memberRows) {
      // Owner takes precedence — never downgrade an already-owner row.
      if (byId.has(r.id)) continue;
      byId.set(r.id, {
        id: r.id,
        slug: r.slug,
        name: r.name,
        ownerId: r.ownerId,
        role: r.role,
      });
    }

    const all = [...byId.values()];
    const narrowed = patAllowlist ? all.filter((r) => patAllowlist.has(r.id)) : all;
    return { projects: narrowed };
  },
});
