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
import { writeEnvironmentsLimits } from '../../projects/environments-service.js';
import { readableLiveBranch } from '../../projects/release-model.js';
import {
  createProject,
  ProjectSlugTakenError,
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
  const limits = (raw as { environmentsLimits?: unknown }).environmentsLimits;
  if (limits !== undefined && (typeof limits === 'string' || limits === null)) {
    ctx.addIssue({
      code: 'custom',
      path: ['environmentsLimits'],
      message: BARE_LIMITS_MESSAGE,
    });
  }
}

/** `environments.limits` is a leaf of a shared document, so a write to it says what it read. */
const BARE_LIMITS_MESSAGE =
  'environmentsLimits is `{ base, value }` rather than a bare string: `base` is the `limits` that `forge_projects.get` answered with (null where there was none) and `value` is what you want it to say (null clears it). A bare string overwrote whatever another writer had stored in the meantime without anybody hearing about it.';

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
            kind: z.enum(projectKinds).optional(),
            environmentsLimits: z
              .object({
                base: z.string().max(8000).nullable(),
                value: z.string().trim().max(8000).nullable(),
              })
              .strict()
              .optional(),
            workspaceSetup: z.string().trim().max(8000).nullable().optional(),
          })
          .strict()
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
    if (input.patch.environmentsLimits !== undefined) {
      await writeEnvironmentsLimits({
        projectId: input.projectId,
        base: input.patch.environmentsLimits.base,
        value: input.patch.environmentsLimits.value,
      });
    }

    if (Object.keys(updates).length === 0) {
      const summary = await readProjectSummary(input.projectId);
      if (!summary) throw new Error('NOT_FOUND: project not found');
      return { project: summary };
    }
    const project = await updateProject(input.projectId, updates);
    if (!project) throw new Error('NOT_FOUND: project not found');
    return { project };
  },
});

const getInputSchema = z.object({ projectId: z.uuid() }).strict();

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
