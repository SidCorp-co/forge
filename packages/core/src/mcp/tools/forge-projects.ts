import { z } from 'zod';
import { type ProjectMemberRole, projectKinds } from '../../db/schema.js';
import {
  effectiveProjectRole,
  loadOrgRole,
  loadPersonalOrgId,
  orgRoleAtLeast,
} from '../../lib/authz.js';
import {
  createProject,
  listProjectsByIds,
  ProjectSlugTakenError,
  readPreviewDeploy,
  readProjectSummary,
  updateProject,
} from '../../projects/service.js';
import {
  type ContextScopedMcpToolFactory,
  loadVisibleProjectIdsForPrincipal,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';

/**
 * Enumerate projects visible to the principal — explicit membership (any
 * role) plus org owner/admin implicit access (lib/authz.ts is the single
 * rule). Role values follow the `projectMemberRoles` enum
 * (`admin | member | viewer`).
 */

const inputSchema = z.object({}).strict();

type ListedProject = {
  id: string;
  slug: string;
  name: string;
  orgId: string;
  role: ProjectMemberRole | null;
};

export const forgeProjectsListTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects.list',
  description:
    "List projects visible to the principal (explicit project membership of any role, plus org owner/admin implicit access). For PAT principals, results are additionally narrowed to the token's projectIds allowlist when set. Returns id, slug, name, orgId, role (effective: admin|member|viewer).",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    inputSchema.parse(args);
    const { principal } = ctx;
    const userId = principalUserId(principal);

    const visibleIds = await loadVisibleProjectIdsForPrincipal(principal);
    if (visibleIds.length === 0) return { projects: [] };

    const rows = await listProjectsByIds(visibleIds);

    const listed: ListedProject[] = [];
    for (const r of rows) {
      const access = await effectiveProjectRole(userId, r.id);
      listed.push({ ...r, role: access?.role ?? null });
    }
    return { projects: listed };
  },
});

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
    // Org tier — omitted = the caller's personal org.
    orgId: z.uuid().optional(),
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
    "Create a new project in an org (orgId optional — defaults to the caller's personal org; the caller becomes a project admin). Accepts slug+name plus optional initial description/repoPath/baseBranch/productionBranch. PAT principals must carry the `write` scope and have a null `projectIds` allowlist (scoped PATs are refused). Returns id/slug/name/orgId/createdBy/apiKey/createdAt — the apiKey is needed for widget install and device pairing.",
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

    const creatorId = principalUserId(principal);
    // Resolve the target org: explicit orgId (caller must be an org member)
    // or the caller's personal org.
    let orgId: string;
    if (input.orgId) {
      const orgRole = await loadOrgRole(input.orgId, creatorId);
      if (!orgRole) throw new Error('NOT_FOUND: org not found or not accessible');
      orgId = input.orgId;
    } else {
      const personal = await loadPersonalOrgId(creatorId);
      if (!personal) throw new Error('INTERNAL: personal org missing — run migrations');
      orgId = personal;
    }
    try {
      const created = await createProject({
        slug: input.slug,
        name: input.name,
        orgId,
        createdBy: creatorId,
        description: input.description,
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        productionBranch: input.productionBranch,
      });
      return { project: created };
    } catch (err) {
      if (err instanceof ProjectSlugTakenError) {
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
        // cm:guard exposed here and not left to REST because REST PATCH needs a user JWT — a device/MCP principal cannot reach it, and the only projects that need `website` are set up by an agent. Removing it makes the field create-only again for anyone without a browser session.
        kind: z.enum(projectKinds).optional(),
        // cm:guard scoped write for `previewDeploy.notes` ONLY — the rest of previewDeploy holds testCredentials and stays REST-only. This merges into the existing jsonb; it must never replace it, or a note would delete the credentials beside it.
        previewDeployNotes: z.string().trim().max(8000).nullable().optional(),
        // cm:guard writable over MCP so the stage that just repaired a workspace can record the procedure that WORKED — the whole saving depends on the loop closing without a human, and no browser session exists on a runner box. It is read by the setup agent and executed by nobody, so treat a rewrite as documentation, not configuration: never overwrite a human-authored procedure with a guess.
        workspaceSetup: z.string().trim().max(8000).nullable().optional(),
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
    "Update project settings (name, description, repoPath, baseBranch, productionBranch, kind). `kind` is the project's SHAPE, not a label: `website` means an Epodsystem-backed storefront where the store is the source of truth and a git repo is optional, and the runner then skips the git preflight and the workspace refresh for every job. Set it on a project that has no repo; never set it on one that does, or its stages stop verifying the checkout they run in. Caller must be org owner/admin on the project's org (a merely-invited project admin cannot mutate settings — matches REST PATCH /api/projects/:id). PAT principals must additionally carry the `write` scope. `workspaceSetup` is prose describing how to bring this repo's workspace to a state a stage can build, test and commit in (install commands, hook setup, toolchain quirks) — the runner's setup agent reads it before every stage that lands in a broken workspace, so writing it once retires a per-job derivation. Record only a procedure you actually ran; null clears it. Sensitive fields (webhookSecret, apiKey, agentConfig, defaultDeviceId) stay on REST; previewDeploy is otherwise read-only via forge_projects.get, with ONE scoped exception: `previewDeployNotes` writes `previewDeploy.notes` — the how-to-use and known limits of the project's test resources (which surfaces the test account can reach, which states this environment never contains, what must not be faked). Write it as prose for whoever plans a live walk. NEVER put a secret in it: it is readable by every project member and is injected into agent prompts as `{{project:test-notes}}`. null clears it.",
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
    const access = await effectiveProjectRole(userId, input.projectId);
    // Non-member returns NOT_FOUND (not FORBIDDEN) to avoid leaking
    // existence; a member below the org-admin bar gets the truthful FORBIDDEN.
    if (!access?.role) {
      throw new Error('NOT_FOUND: project not found or not accessible');
    }
    if (!orgRoleAtLeast(access.orgRole, 'admin')) {
      throw new Error('FORBIDDEN: requires org admin (project admin role is insufficient)');
    }

    const updates: Record<string, unknown> = {};
    if (input.patch.name !== undefined) updates.name = input.patch.name;
    if (input.patch.description !== undefined) updates.description = input.patch.description;
    if (input.patch.repoPath !== undefined) updates.repoPath = input.patch.repoPath;
    if (input.patch.baseBranch !== undefined) updates.baseBranch = input.patch.baseBranch;
    if (input.patch.productionBranch !== undefined) {
      updates.productionBranch = input.patch.productionBranch;
    }
    if (input.patch.kind !== undefined) updates.kind = input.patch.kind;
    if (input.patch.workspaceSetup !== undefined) {
      updates.workspaceSetup = input.patch.workspaceSetup;
    }
    if (input.patch.previewDeployNotes !== undefined) {
      const current = await readPreviewDeploy(input.projectId);
      updates.previewDeploy = { ...current, notes: input.patch.previewDeployNotes };
    }

    const project = await updateProject(input.projectId, updates);
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
    'Fetch project detail visible to the principal — id, slug, name, description, orgId, createdBy, role (effective: admin|member|viewer), repoPath, workspaceSetup, baseBranch, productionBranch, defaultDeviceId, previewDeploy.{stagingUrl,stagingApiUrl,testingUrls,testCredentials,notes}, createdAt. `workspaceSetup` is the project-declared setup procedure (install commands, hook setup, toolchain quirks) — follow it rather than guessing when a checkout will not build, and if it is null and you establish one, record it via forge_projects.update. READ previewDeploy.notes before planning any live verification: it carries the how-to-use and the known limits of these resources (what a test account can and cannot reach, states this environment never contains), and those limits decide whether an acceptance criterion is walkable AT ALL — check it while the work is still being scoped, not at the testing gate. Any effective project role can read. PAT principals must carry the `read` scope. Sensitive fields (agentConfig, webhookSecret, apiKey) stay on REST.',
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

    const proj = await readProjectSummary(input.projectId);
    if (!proj) throw new Error('NOT_FOUND: project not found or not accessible');

    // Resolve the effective caller role; a non-member surfaces NOT_FOUND so
    // the namespace stays non-enumerable.
    const access = await effectiveProjectRole(userId, input.projectId);
    if (!access?.role) {
      throw new Error('NOT_FOUND: project not found or not accessible');
    }
    const role: ProjectMemberRole = access.role;

    // Normalize previewDeploy: tolerate null + missing inner fields so the
    // response shape is stable regardless of DB state.
    const pd = (proj.previewDeploy ?? {}) as Record<string, unknown>;
    const previewDeploy = {
      stagingUrl: (pd.stagingUrl as string | null | undefined) ?? null,
      stagingApiUrl: (pd.stagingApiUrl as string | null | undefined) ?? null,
      testingUrls: Array.isArray(pd.testingUrls) ? pd.testingUrls : [],
      testCredentials: Array.isArray(pd.testCredentials) ? pd.testCredentials : [],
      notes: (pd.notes as string | null | undefined) ?? null,
    };

    return {
      project: {
        id: proj.id,
        slug: proj.slug,
        name: proj.name,
        description: proj.description,
        orgId: proj.orgId,
        createdBy: proj.createdBy,
        role,
        repoPath: proj.repoPath,
        // cm:guard this handler returns a HAND-BUILT object, so adding a column to the `select` above is only half the change — the field is fetched and then silently dropped. Shipped exactly that way on 2026-08-18 while the project-settings guide already told agents `get` returns it.
        workspaceSetup: proj.workspaceSetup,
        baseBranch: proj.baseBranch,
        productionBranch: proj.productionBranch,
        defaultDeviceId: proj.defaultDeviceId,
        previewDeploy,
        createdAt: proj.createdAt,
      },
    };
  },
});
