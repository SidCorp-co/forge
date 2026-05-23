import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  type ProjectMemberRole,
  projectMembers,
  projects,
  users,
} from '../../db/schema.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsAdmin,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';

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

/**
 * Mirrors `generateApiKey` in `projects/routes.ts` — kept local because the
 * REST helper is private and lifting it into a shared module is out of scope.
 * Same `fk_` prefix + 192 bits of entropy so the existing key validators
 * (widget install, MCP device pairing) accept the value unchanged.
 */
function generateApiKey(): string {
  return `fk_${randomBytes(24).toString('hex')}`;
}

const slugField = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens')
  .min(3)
  .max(64);

const createInputSchema = z
  .object({
    slug: slugField,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    repoPath: z.string().trim().max(500).optional(),
    baseBranch: z.string().trim().max(100).optional(),
    productionBranch: z.string().trim().max(100).optional(),
  })
  .strict();

/**
 * User-facing project creation over MCP (Issue: PAT users had no non-browser
 * path to provision a project — `forge_admin_projects.create` requires
 * `users.isCeo=true`, and the REST `POST /api/projects` is session-JWT only).
 *
 * Gates:
 *   - PAT principal must carry the `write` scope. Read-only PATs are refused
 *     with FORBIDDEN_SCOPE so a leaked read-token can't mint projects.
 *   - PAT principal with a non-null `projectIds` allowlist is refused — an
 *     allowlisted PAT is intentionally scoped to existing projects, and
 *     letting it create new ones would silently escape that scope.
 *   - Device principals always pass these checks (no scope vector).
 *
 * The created project is always owned by the principal's underlying user —
 * cross-tenant ownership transfer stays on `forge_admin_projects.create`.
 */
export const forgeProjectsCreateTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects.create',
  description:
    "Create a new project owned by the calling principal. PAT principals must carry the `write` scope and have a null `projectIds` allowlist (scoped PATs are refused). Mirrors REST POST /api/projects: inserts the project, seeds the owner's project_members row, and returns id/slug/name/ownerId/createdAt.",
  inputSchema: zodToMcpSchema(createInputSchema),
  handler: async (args) => {
    const input = createInputSchema.parse(args);
    const { principal } = ctx;

    if (principal.kind === 'pat') {
      if (!principal.scopes.includes('write')) {
        throw new Error('FORBIDDEN_SCOPE: requires write scope on the PAT');
      }
      if (principal.projectIds !== null) {
        throw new Error(
          'FORBIDDEN_SCOPE: PAT with a projectIds allowlist cannot create new projects',
        );
      }
    }

    const ownerId = principalUserId(principal);
    try {
      const created = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(projects)
          .values({
            slug: input.slug,
            name: input.name,
            ownerId,
            description: input.description ?? null,
            repoPath: input.repoPath ?? null,
            baseBranch: input.baseBranch ?? null,
            productionBranch: input.productionBranch ?? null,
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
  },
});

const updateInputSchema = z
  .object({
    projectId: z.uuid(),
    patch: z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        repoPath: z.string().trim().max(500).nullable().optional(),
        baseBranch: z.string().trim().max(100).nullable().optional(),
        productionBranch: z.string().trim().max(100).nullable().optional(),
      })
      .strict()
      .refine((o) => Object.keys(o).length > 0, { message: 'patch must have at least one field' }),
  })
  .strict();

/**
 * Update a project's settings (name/description/repoPath/baseBranch/
 * productionBranch) — the subset of `updateProjectSchema` that's safe to
 * expose to MCP. Sensitive fields (webhookSecret, apiKey, agentConfig,
 * previewDeploy, defaultDeviceId) intentionally stay on the REST handler.
 *
 * Membership is enforced via `assertPrincipalIsAdmin`, which already handles
 * PAT allowlist narrowing and translates allowlist misses to NOT_FOUND so
 * the project namespace isn't enumerable.
 */
export const forgeProjectsUpdateTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects.update',
  description:
    'Update project settings (name, description, repoPath, baseBranch, productionBranch). Caller must be owner or admin on the project; PAT principals must additionally carry the `write` scope. Sensitive fields (webhookSecret, apiKey, agentConfig, previewDeploy) stay on REST.',
  inputSchema: zodToMcpSchema(updateInputSchema),
  handler: async (args) => {
    const input = updateInputSchema.parse(args);
    const { principal } = ctx;

    if (principal.kind === 'pat' && !principal.scopes.includes('write')) {
      throw new Error('FORBIDDEN_SCOPE: requires write scope on the PAT');
    }

    await assertPrincipalIsAdmin(principal, input.projectId);

    const updates: Record<string, unknown> = {};
    if (input.patch.name !== undefined) updates.name = input.patch.name;
    if (input.patch.description !== undefined) updates.description = input.patch.description;
    if (input.patch.repoPath !== undefined) updates.repoPath = input.patch.repoPath;
    if (input.patch.baseBranch !== undefined) updates.baseBranch = input.patch.baseBranch;
    if (input.patch.productionBranch !== undefined) {
      updates.productionBranch = input.patch.productionBranch;
    }

    const updated = await db
      .update(projects)
      .set(updates)
      .where(eq(projects.id, input.projectId))
      .returning({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        ownerId: projects.ownerId,
        description: projects.description,
        repoPath: projects.repoPath,
        baseBranch: projects.baseBranch,
        productionBranch: projects.productionBranch,
      });

    const project = updated[0];
    if (!project) throw new Error('NOT_FOUND: project not found');
    return { project };
  },
});
