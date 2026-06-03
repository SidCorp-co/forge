import { randomBytes } from 'node:crypto';
import { and, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { type ProjectMemberRole, agentSessions, projectMembers, projects } from '../../db/schema.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../../lib/db-errors.js';
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
    "List projects visible to the principal (projects owned + ones the user is a member of). For PAT principals, results are additionally narrowed to the token's projectIds allowlist when set. Returns id, slug, name, ownerId, role.",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    inputSchema.parse(args);
    const { principal } = ctx;
    const userId = principal.kind === 'device' ? principal.device.ownerId : principal.userId;
    const patAllowlist =
      principal.kind === 'pat' && principal.projectIds !== null
        ? new Set(principal.projectIds)
        : null;

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
 * path to provision a project — the caller becomes the owner, and the REST
 * `POST /api/projects` is session-JWT only).
 *
 * Surface superset of REST: REST `createProjectSchema` (projects/routes.ts)
 * accepts only slug+name and forces description/repoPath/baseBranch/
 * productionBranch through a follow-up PATCH. MCP collapses both steps so
 * PAT-only clients (Cursor, Cline, Claude Code) can provision in one call —
 * the security model is unchanged because the caller becomes owner of the
 * just-created project, which is the same gate REST's PATCH would apply.
 *
 * Gates:
 *   - PAT principal must carry the `write` scope. Read-only PATs are refused
 *     with FORBIDDEN_SCOPE so a leaked read-token can't mint projects.
 *   - PAT principal with a non-null `projectIds` allowlist is refused — an
 *     allowlisted PAT is intentionally scoped to existing projects, and
 *     letting it create new ones would silently escape that scope.
 *   - Device principals always pass these checks (no scope vector).
 *
 * Returns the apiKey alongside identity fields: the caller IS the new owner,
 * so they need the key to install the embeddable widget or pair an MCP
 * device. REST POST /api/projects also returns apiKey (routes.ts:148-154).
 *
 * The created project is always owned by the principal's underlying user;
 * there is no cross-tenant create path over MCP.
 */
export const forgeProjectsCreateTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects.create',
  description:
    'Create a new project owned by the calling principal. Accepts slug+name plus optional initial description/repoPath/baseBranch/productionBranch (superset of REST POST /api/projects, which forces these through a follow-up PATCH). PAT principals must carry the `write` scope and have a null `projectIds` allowlist (scoped PATs are refused). Returns id/slug/name/ownerId/apiKey/createdAt — the apiKey is needed for widget install and device pairing.',
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
            // ISS-274 — default to 'main' when the caller omits the branch so a
            // new project never surfaces a null-base misconfig at pipeline time
            // (resolveIssueBranches has no 'main' fallback). An explicitly
            // provided value is preserved (the `?? 'main'` only fires on omit).
            baseBranch: input.baseBranch ?? 'main',
            productionBranch: input.productionBranch ?? 'main',
            apiKey: generateApiKey(),
          })
          .returning({
            id: projects.id,
            slug: projects.slug,
            name: projects.name,
            ownerId: projects.ownerId,
            apiKey: projects.apiKey,
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
      // `isUniqueViolation` matches any SQLSTATE 23505 across the projects /
      // projectMembers / api_key constraints; disambiguate by constraint name
      // so an apiKey collision (or any future unique index on `projects`)
      // isn't misreported as SLUG_TAKEN. With drizzle-orm/postgres-js the
      // constraint name lives on `err.cause.constraint_name` (the helper
      // walks the wrapper for us).
      if (isUniqueViolation(err)) {
        if (uniqueViolationConstraint(err) === 'projects_slug_unique') {
          throw new Error('BAD_REQUEST: SLUG_TAKEN: slug already in use');
        }
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
      // Zod v4 `.strict()` only rejects unknown keys; it does NOT strip
      // explicit-undefined values from optional fields. So `{name: undefined}`
      // would slip past an `Object.keys(o).length > 0` guard (one key) but
      // the downstream `!== undefined` filter strips every field, leaving an
      // empty Drizzle SET and producing malformed SQL. Refine on VALUES so
      // the schema's intent (require at least one real field) matches runtime.
      .refine((o) => Object.values(o).some((v) => v !== undefined), {
        message: 'patch must have at least one defined field',
      }),
  })
  .strict();

/**
 * Update a project's settings (name/description/repoPath/baseBranch/
 * productionBranch) — the subset of `updateProjectSchema` that's safe to
 * expose to MCP. Sensitive fields (webhookSecret, apiKey, agentConfig,
 * defaultDeviceId) intentionally stay on the REST handler. `previewDeploy`
 * is exposed READ-ONLY through `forge_projects.get` (ISS-225); writes stay
 * on REST.
 *
 * Authorization is OWNER-ONLY, matching REST PATCH /api/projects/:id
 * (projects/routes.ts:349-351 — `project.ownerId === userId || role === 'owner'`).
 * The `admin` projectMembers role can manage members/labels via REST but
 * intentionally cannot mutate project settings; the MCP surface honors the
 * same rule so the REST contract stays the single source of truth on who
 * can edit settings. PAT principals additionally need the `write` scope.
 */
export const forgeProjectsUpdateTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects.update',
  description:
    'Update project settings (name, description, repoPath, baseBranch, productionBranch). Caller must be the project owner (members with role=admin cannot mutate settings — matches REST PATCH /api/projects/:id). PAT principals must additionally carry the `write` scope. Sensitive fields (webhookSecret, apiKey, agentConfig, defaultDeviceId) stay on REST; previewDeploy is read-only via forge_projects.get.',
  inputSchema: zodToMcpSchema(updateInputSchema),
  handler: async (args) => {
    const input = updateInputSchema.parse(args);
    const { principal } = ctx;

    if (principal.kind === 'pat' && !principal.scopes.includes('write')) {
      throw new Error('FORBIDDEN_SCOPE: requires write scope on the PAT');
    }

    // PAT allowlist gate first (translates miss to NOT_FOUND so the
    // project namespace isn't enumerable — mirrors assertPrincipalIs*).
    if (
      principal.kind === 'pat' &&
      principal.projectIds !== null &&
      !principal.projectIds.includes(input.projectId)
    ) {
      throw new Error('NOT_FOUND: project not found or not accessible');
    }

    const userId = principalUserId(principal);
    const [proj] = await db
      .select({ ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!proj) throw new Error('NOT_FOUND: project not found or not accessible');

    if (proj.ownerId !== userId) {
      // Not the primary owner — projects can have multiple `owner`-role
      // members via projectMembers; allow those, refuse everyone else.
      const [member] = await db
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(
          and(eq(projectMembers.projectId, input.projectId), eq(projectMembers.userId, userId)),
        )
        .limit(1);
      // Non-member returns NOT_FOUND (not FORBIDDEN) to avoid leaking
      // existence; project-member-not-owner gets the truthful FORBIDDEN.
      if (!member) throw new Error('NOT_FOUND: project not found or not accessible');
      if (member.role !== 'owner') {
        throw new Error('FORBIDDEN: requires project owner (admin role is insufficient)');
      }
    }

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

const getInputSchema = z.object({ projectId: z.uuid() }).strict();

/**
 * ISS-225 — read project detail for worker-agent runtime context (repo paths,
 * branches, staging URLs, test credentials). Companion to
 * `forge_projects.list` which intentionally stays slim. The response shape
 * is locked: `agentConfig`, `webhookSecret`, `apiKey` stay on REST
 * (sensitive / not needed by agents).
 *
 * Authorization: any project member (owner/admin/member) can read. PAT
 * principals must carry the `read` scope and a matching `projectIds`
 * allowlist (mismatch → NOT_FOUND so the project namespace stays
 * non-enumerable — mirrors update tool).
 */
export const forgeProjectsGetTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects.get',
  description:
    'Fetch project detail visible to the principal — id, slug, name, description, ownerId, role, repoPath, baseBranch, productionBranch, defaultDeviceId, previewDeploy.{stagingUrl,stagingApiUrl,testingUrls,testCredentials}, createdAt. Any project member (owner/admin/member) can read. PAT principals must carry the `read` scope. Sensitive fields (agentConfig, webhookSecret, apiKey) stay on REST.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const input = getInputSchema.parse(args);
    const { principal } = ctx;

    if (principal.kind === 'pat' && !principal.scopes.includes('read')) {
      throw new Error('FORBIDDEN_SCOPE: requires read scope on the PAT');
    }
    // PAT allowlist gate first — surface NOT_FOUND on miss so the project
    // namespace isn't enumerable (mirrors update tool).
    if (
      principal.kind === 'pat' &&
      principal.projectIds !== null &&
      !principal.projectIds.includes(input.projectId)
    ) {
      throw new Error('NOT_FOUND: project not found or not accessible');
    }

    const userId = principalUserId(principal);

    const [proj] = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        description: projects.description,
        ownerId: projects.ownerId,
        repoPath: projects.repoPath,
        baseBranch: projects.baseBranch,
        productionBranch: projects.productionBranch,
        defaultDeviceId: projects.defaultDeviceId,
        previewDeploy: projects.previewDeploy,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!proj) throw new Error('NOT_FOUND: project not found or not accessible');

    // Resolve caller role. Owner short-circuit keeps the hot path at one
    // query; a non-member surfaces NOT_FOUND so the namespace stays
    // non-enumerable.
    let role: 'owner' | ProjectMemberRole;
    if (proj.ownerId === userId) {
      role = 'owner';
    } else {
      const [member] = await db
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(
          and(eq(projectMembers.projectId, input.projectId), eq(projectMembers.userId, userId)),
        )
        .limit(1);
      if (!member) {
        throw new Error('NOT_FOUND: project not found or not accessible');
      }
      role = member.role;
    }

    // Normalize previewDeploy: tolerate null + missing inner fields so the
    // response shape is stable regardless of DB state.
    const pd = (proj.previewDeploy ?? {}) as Record<string, unknown>;
    const previewDeploy = {
      stagingUrl: (pd.stagingUrl as string | null | undefined) ?? null,
      stagingApiUrl: (pd.stagingApiUrl as string | null | undefined) ?? null,
      testingUrls: Array.isArray(pd.testingUrls) ? pd.testingUrls : [],
      testCredentials: Array.isArray(pd.testCredentials) ? pd.testCredentials : [],
    };

    return {
      project: {
        id: proj.id,
        slug: proj.slug,
        name: proj.name,
        description: proj.description,
        ownerId: proj.ownerId,
        role,
        repoPath: proj.repoPath,
        baseBranch: proj.baseBranch,
        productionBranch: proj.productionBranch,
        defaultDeviceId: proj.defaultDeviceId,
        previewDeploy,
        createdAt: proj.createdAt,
      },
    };
  },
});

const archiveInputSchema = z
  .object({
    projectId: z.uuid(),
    confirm: z.boolean().optional(),
  })
  .strict();

/**
 * Hard-delete a project. Authorization is owner/admin on the project (via
 * `assertPrincipalIsAdmin`), matching the gate the action carried while it
 * lived on the now-removed `forge_admin_projects` dispatcher. Requires
 * `confirm:true` and refuses with PROJECT_BUSY if any agent_sessions are
 * queued/running, so an archive can't strand in-flight work.
 */
export const forgeProjectsArchiveTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects.archive',
  description:
    'Hard-delete a project. Requires owner/admin on the project and `confirm:true`. Refuses with PROJECT_BUSY if the project has any queued/running agent sessions. Returns `{ archived: true, projectId, actorUserId }`.',
  inputSchema: zodToMcpSchema(archiveInputSchema),
  handler: async (args) => {
    const input = archiveInputSchema.parse(args);
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
