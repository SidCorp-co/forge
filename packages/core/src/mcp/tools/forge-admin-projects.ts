import { randomBytes } from 'node:crypto';
import { and, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  agentSessions,
  issues,
  projectMembers,
  projects,
  users,
} from '../../db/schema.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsAdmin,
  loadVisibleProjectIdsForPrincipal,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';

const createDataSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens')
      .min(3)
      .max(64),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    repoPath: z.string().trim().max(500).optional(),
    baseBranch: z.string().trim().max(100).optional(),
    productionBranch: z.string().trim().max(100).optional(),
  })
  .strict();

const inputSchema = z
  .object({
    action: z.enum(['list', 'create', 'archive']),
    // list-only
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    includeStats: z.boolean().optional(),
    // create-only
    data: createDataSchema.optional(),
    // archive-only
    projectId: z.uuid().optional(),
    confirm: z.boolean().optional(),
  })
  .strict();

function generateApiKey(): string {
  return `fk_${randomBytes(24).toString('hex')}`;
}

export const forgeAdminProjectsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_admin_projects',
  description:
    "Manage the projects in your scope (projects you own or are a member of). Actions: `list` (paginated; `includeStats:true` adds memberCount/issueCount), `create` (slug+name; the calling user becomes owner; returns project without apiKey), `archive` (hard-delete; requires owner/admin on the project, `confirm:true`, and refuses with PROJECT_BUSY if any agent_sessions are queued/running).",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);

    if (input.action === 'list') {
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;
      const visibleIds = await loadVisibleProjectIdsForPrincipal(ctx.principal);
      if (visibleIds.length === 0) {
        return { projects: [], total: 0 };
      }
      const totalRows = await db
        .select({ total: count() })
        .from(projects)
        .where(inArray(projects.id, visibleIds));
      const total = Number(totalRows[0]?.total ?? 0);
      const baseRows = await db
        .select({
          id: projects.id,
          slug: projects.slug,
          name: projects.name,
          ownerId: projects.ownerId,
          ownerEmail: users.email,
          repoPath: projects.repoPath,
          baseBranch: projects.baseBranch,
          createdAt: projects.createdAt,
        })
        .from(projects)
        .leftJoin(users, eq(users.id, projects.ownerId))
        .where(inArray(projects.id, visibleIds))
        .orderBy(projects.createdAt)
        .limit(limit)
        .offset(offset);

      if (!input.includeStats || baseRows.length === 0) {
        return { projects: baseRows, total };
      }

      const ids = baseRows.map((r) => r.id);
      const memberCounts = await db
        .select({ projectId: projectMembers.projectId, n: count() })
        .from(projectMembers)
        .where(inArray(projectMembers.projectId, ids))
        .groupBy(projectMembers.projectId);
      const issueCounts = await db
        .select({ projectId: issues.projectId, n: count() })
        .from(issues)
        .where(inArray(issues.projectId, ids))
        .groupBy(issues.projectId);
      const memberMap = new Map(memberCounts.map((r) => [r.projectId, Number(r.n)]));
      const issueMap = new Map(issueCounts.map((r) => [r.projectId, Number(r.n)]));
      const withStats = baseRows.map((r) => ({
        ...r,
        memberCount: memberMap.get(r.id) ?? 0,
        issueCount: issueMap.get(r.id) ?? 0,
      }));
      return { projects: withStats, total };
    }

    if (input.action === 'create') {
      if (!input.data) {
        throw new Error('BAD_REQUEST: data is required for action=create');
      }
      const { slug, name, description, repoPath, baseBranch, productionBranch } = input.data;
      // The calling user always becomes the owner — no cross-tenant create.
      const ownerId = principalUserId(ctx.principal);
      try {
        const created = await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(projects)
            .values({
              slug,
              name,
              ownerId,
              description: description ?? null,
              repoPath: repoPath ?? null,
              baseBranch: baseBranch ?? null,
              productionBranch: productionBranch ?? null,
              apiKey: generateApiKey(),
            })
            .returning({
              id: projects.id,
              slug: projects.slug,
              name: projects.name,
              ownerId: projects.ownerId,
              createdAt: projects.createdAt,
            });
          const project = inserted[0];
          if (!project) throw new Error('projects: insert returned no row');
          await tx.insert(projectMembers).values({
            userId: ownerId,
            projectId: project.id,
            role: 'owner',
          });
          return project;
        });
        return { project: created };
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new Error('BAD_REQUEST: SLUG_TAKEN: slug already in use');
        }
        throw err;
      }
    }

    // archive
    if (!input.projectId) {
      throw new Error('BAD_REQUEST: projectId is required for action=archive');
    }
    if (!input.confirm) {
      throw new Error('BAD_REQUEST: archive requires confirm:true');
    }
    const projectId = input.projectId;
    // Only an owner/admin of the project may archive it.
    await assertPrincipalIsAdmin(ctx.principal, projectId);
    const activeRows = await db
      .select({ active: count() })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.projectId, projectId),
          inArray(agentSessions.status, ['queued', 'running']),
        ),
      );
    const activeCount = Number(activeRows[0]?.active ?? 0);
    if (activeCount > 0) {
      throw new Error(
        `BAD_REQUEST: PROJECT_BUSY: project has ${activeCount} in-flight agent session(s)`,
      );
    }
    const deleted = await db
      .delete(projects)
      .where(eq(projects.id, projectId))
      .returning({ id: projects.id });
    if (deleted.length === 0) {
      throw new Error('NOT_FOUND: project not found');
    }
    return {
      archived: true,
      projectId,
      actorUserId: principalUserId(ctx.principal),
    };
  },
});
