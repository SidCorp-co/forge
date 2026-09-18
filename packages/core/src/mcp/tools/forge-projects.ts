import { z } from 'zod';
import { type ProjectMemberRole, projectKinds } from '../../db/schema.js';
import {
  effectiveProjectRole,
  loadOrgRole,
  loadPersonalOrgId,
  maxProjectRole,
  orgDerivedProjectRole,
  orgRoleAtLeast,
} from '../../lib/authz.js';
import {
  normalizeEnvironments,
  RETIRED_PREVIEW_DEPLOY_NOTES_MESSAGE,
} from '../../projects/environments.js';
import { readableLiveBranch } from '../../projects/release-model.js';
import {
  createProject,
  ProjectSlugTakenError,
  readEnvironments,
  readProjectSummary,
  updateProject,
} from '../../projects/service.js';
import {
  type ContextScopedMcpToolFactory,
  loadVisibleProjectsWithRoleForPrincipal,
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

    // cm:guard the role is derived from the SAME two columns `effectiveProjectRole` reads, through the SAME expression, and never by a per-row call: this handler ran `effectiveProjectRole` once per project — a third visit to `project_members` and `organization_members` after the visibility join had already selected both — and a visible list of fifty projects cost fifty-two serialised queries (ISS-1025). A future field that needs more than the role belongs in `listVisibleProjectsWithRole`'s projection, not in a loop reinstated here.
    const rows = await loadVisibleProjectsWithRoleForPrincipal(principal);
    const listed: ListedProject[] = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      orgId: r.orgId,
      role: maxProjectRole(r.memberRole, orgDerivedProjectRole(r.orgRole)),
    }));
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
    liveBranch: z.string().trim().max(100).optional(),
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
 * liveBranch through a follow-up PATCH. MCP collapses both steps so
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
    "Create a new project in an org (orgId optional — defaults to the caller's personal org; the caller becomes a project admin). Accepts slug+name plus optional initial description/repoPath/baseBranch/liveBranch. PAT principals must carry the `write` scope and have a null `projectIds` allowlist (scoped PATs are refused). Returns id/slug/name/orgId/createdBy/apiKey/createdAt — the apiKey is needed for widget install and device pairing.",
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
        liveBranch: input.liveBranch,
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

/**
 * ISS-1069 — `previewDeployNotes` is refused on the RAW patch, before the strict object below
 * reads it.
 *
 * `.strict()` does refuse an unknown key, but it refuses it as "Unrecognized key", which tells an
 * agent holding a tool description one version old that it typed something wrong and nothing about
 * what replaced it. The message is the deliverable: this is the same door `refuseRetiredProjectKeys`
 * holds on REST, and the same reason.
 */
function refuseRetiredPatchKeys(raw: unknown, ctx: z.RefinementCtx): void {
  if (!raw || typeof raw !== 'object') return;
  if ('previewDeployNotes' in (raw as Record<string, unknown>)) {
    ctx.addIssue({
      code: 'custom',
      path: ['previewDeployNotes'],
      message: RETIRED_PREVIEW_DEPLOY_NOTES_MESSAGE,
    });
  }
}

const updateInputSchema = z
  .object({
    projectId: z.uuid(),
    patch: z
      .unknown()
      .superRefine(refuseRetiredPatchKeys)
      .pipe(
        z
          .object({
            name: z.string().trim().min(1).max(200).optional(),
            description: z.string().trim().max(2000).nullable().optional(),
            repoPath: z.string().trim().max(500).nullable().optional(),
            baseBranch: z.string().trim().max(100).nullable().optional(),
            liveBranch: z.string().trim().max(100).nullable().optional(),
            // cm:guard exposed here and not left to REST because REST PATCH needs a user JWT — a device/MCP principal cannot reach it, and the only projects that need `website` are set up by an agent. Removing it makes the field create-only again for anyone without a browser session.
            kind: z.enum(projectKinds).optional(),
            // cm:guard scoped write for `environments.limits` ONLY — the rest of `environments` holds testCredentials and stays REST-only. This READ-MODIFY-WRITES the existing jsonb; it must never replace it, or a limits edit would delete the credentials beside it. That is the price stated for keeping REST's own wholesale-replacement semantics (ISS-1069).
            environmentsLimits: z.string().trim().max(8000).nullable().optional(),
            // cm:guard writable over MCP so the stage that just repaired a workspace can record the procedure that WORKED — the whole saving depends on the loop closing without a human, and no browser session exists on a runner box. It is read by the setup agent and executed by nobody, so treat a rewrite as documentation, not configuration: never overwrite a human-authored procedure with a guess.
            workspaceSetup: z.string().trim().max(8000).nullable().optional(),
          })
          .strict()
          // cm:guard refine on VALUES and never on key count: zod v4 `.strict()` rejects unknown keys but does NOT strip an explicit `undefined` from an optional field, so `{name: undefined}` passes an `Object.keys(o).length > 0` guard and then loses every field to the downstream `!== undefined` filter, leaving an empty drizzle SET and malformed SQL.
          .refine((o) => Object.values(o).some((v) => v !== undefined), {
            message: 'patch must have at least one defined field',
          }),
      ),
  })
  .strict();

/**
 * Update a project's settings (name/description/repoPath/baseBranch/
 * liveBranch) — the subset of `updateProjectSchema` that's safe to
 * expose to MCP. Sensitive fields (webhookSecret, apiKey, agentConfig,
 * defaultDeviceId) intentionally stay on the REST handler. `environments`
 * is exposed READ-ONLY through `forge_projects.get` (ISS-225); writes stay
 * on REST, with the one scoped exception below.
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
    "Update project settings (name, description, repoPath, baseBranch, liveBranch, kind). `kind` is the project's SHAPE, not a label: `website` means an Epodsystem-backed storefront where the store is the source of truth and a git repo is optional, and the runner then skips the git preflight and the workspace refresh for every job. Set it on a project that has no repo; never set it on one that does, or its stages stop verifying the checkout they run in. Caller must be org owner/admin on the project's org (a merely-invited project admin cannot mutate settings — matches REST PATCH /api/projects/:id). PAT principals must additionally carry the `write` scope. `workspaceSetup` is prose describing how to bring this repo's workspace to a state a stage can build, test and commit in (install commands, hook setup, toolchain quirks) — the runner's setup agent reads it before every stage that lands in a broken workspace, so writing it once retires a per-job derivation. Record only a procedure you actually ran; null clears it. Sensitive fields (webhookSecret, apiKey, agentConfig, defaultDeviceId) stay on REST; `environments` is otherwise read-only via forge_projects.get, with ONE scoped exception: `environmentsLimits` writes `environments.limits` and leaves every other key of the blob — the credentials included — exactly as it found them. `limits` answers ONE question: what does this environment NOT have? (which surfaces the test account cannot reach, which states this environment never contains, what must not be faked). The field it replaced invited anything and was filled on 4 of 32 projects. NEVER put a secret in it: it is readable by every project member and is injected into agent prompts as `{{project:test-notes}}`. null clears it. `previewDeployNotes` was retired by ISS-1069 and is refused by name.",
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
    if (input.patch.liveBranch !== undefined) {
      updates.liveBranch = input.patch.liveBranch;
    }
    if (input.patch.kind !== undefined) updates.kind = input.patch.kind;
    if (input.patch.workspaceSetup !== undefined) {
      updates.workspaceSetup = input.patch.workspaceSetup;
    }
    // cm:guard READ-MODIFY-WRITE and never a replacement. REST's `environments` patch replaces the
    // column wholesale, deliberately; this narrow door does the opposite, so an agent recording the
    // limits of a test environment cannot delete the credentials, the live address or an unknown key
    // sitting beside them. `readEnvironments` hands back the RAW blob for exactly this reason — the
    // normalised reading names four fields and would drop everything else on the way back down.
    if (input.patch.environmentsLimits !== undefined) {
      const current = await readEnvironments(input.projectId);
      updates.environments = { ...current, limits: input.patch.environmentsLimits };
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
    'Fetch project detail visible to the principal — id, slug, name, description, orgId, createdBy, role (effective: admin|member|viewer), repoPath, workspaceSetup, baseBranch, liveBranch (non-null only under releaseModel `promote`), releaseModel, releaseStrategy, defaultDeviceId, environments.{preview,live,testCredentials,limits}, createdAt. `environments` carries BOTH sides of a deployment: `preview` is `{url, apiUrl, urls[]}` or null — null means this project has no preview side at all, which is normal for a one-box project and is not a gap to report or to work around — and `live` is `{url, apiUrl, commitUrl, commitPath}`, the address a release ships to. `workspaceSetup` is the project-declared setup procedure (install commands, hook setup, toolchain quirks) — follow it rather than guessing when a checkout will not build, and if it is null and you establish one, record it via forge_projects.update. READ environments.limits before planning any live verification: it answers what this environment does NOT have (what a test account cannot reach, states this environment never contains), and those limits decide whether an acceptance criterion is walkable AT ALL — check it while the work is still being scoped, not at the testing gate. If it is empty and you discover such a limit, record it with forge_projects.update `environmentsLimits`. Any effective project role can read. PAT principals must carry the `read` scope. Sensitive fields (agentConfig, webhookSecret, apiKey) stay on REST.',
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

    // cm:guard the READING and not the stored blob, through the one normaliser every reader shares
    // (ISS-1069). Before it, this handler, `readPreviewDeploy` and `loadProjectFactInputs` each
    // picked keys out of the column by hand with `?? {}`, so what an empty value MEANT lived in no
    // single place and the three could disagree about it. `preview: null` here is a one-box project
    // saying it has no other side, and `live.url === null` is the question this shape makes askable.
    const environments = normalizeEnvironments(proj.environments);

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
        liveBranch: readableLiveBranch(proj),
        releaseModel: proj.releaseModel,
        releaseStrategy: proj.releaseStrategy,
        defaultDeviceId: proj.defaultDeviceId,
        environments,
        createdAt: proj.createdAt,
      },
    };
  },
});
