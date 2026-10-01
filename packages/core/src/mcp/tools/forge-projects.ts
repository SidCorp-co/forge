import { z } from 'zod';
import type { ProjectMemberRole } from '../../db/schema.js';
import {
  effectiveProjectRole,
  loadOrgRole,
  loadPersonalOrgId,
  maxProjectRole,
  orgDerivedProjectRole,
  orgRoleAtLeast,
} from '../../lib/authz.js';
import { retiredProjectFieldsMessage } from '../../projects/retired-project-keys.js';
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

function undeclaredOrRetired(tool: string, fields: string) {
  return {
    error: (issue: { code?: string; keys?: string[] }) => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      const keys = issue.keys ?? [];
      const retired = retiredProjectFieldsMessage(keys);
      return `${tool} does not take ${keys.map((k) => `\`${k}\``).join(', ')}; its fields are ${fields}.${retired ? ` ${retired}` : ''}`;
    },
  };
}

const slugField = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens')
  .min(3)
  .max(64);

const createInputSchema = z.strictObject(
  {
    slug: slugField,
    name: z.string().trim().min(1).max(200),
    baseBranch: z.string().trim().max(100).optional(),
    // Org tier — omitted = the caller's personal org.
    orgId: z.uuid().optional(),
  },
  undeclaredOrRetired('forge_projects.create', 'slug, name, baseBranch and orgId'),
);

export const forgeProjectsCreateTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects.create',
  description:
    "Create a new project in an org (orgId optional — defaults to the caller's personal org; the caller becomes a project admin). Accepts slug+name plus an optional initial baseBranch. A checkout is not a project setting: it is the device binding's (`forge-runner bind <slug> --path <dir>`). Where its work lands, its environments, promotions and deployments are its project document, written with PUT /api/projects/:id/config. PAT principals must carry the `write` scope and have a null `projectIds` allowlist (scoped PATs are refused). Returns id/slug/name/orgId/createdBy/apiKey/createdAt — the apiKey is needed for widget install and device pairing.",
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
        baseBranch: input.baseBranch,
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

const UNDECLARED_PATCH_KEY = {
  error: (issue: { code?: string; keys?: string[] }) => {
    if (issue.code !== 'unrecognized_keys') return undefined;
    const keys = issue.keys ?? [];
    const retired = retiredProjectFieldsMessage(keys);
    return `forge_projects.update does not take ${keys.map((k) => `\`${k}\``).join(', ')}; its fields are name, baseBranch and workspaceSetup.${retired ? ` ${retired}` : ''} Whether a project's work lands in git (\`source.type\`), its environments, promotions, deployments and testing profiles are its project document: read it with forge_config (action \`get\`, field \`projectDocument\`) and write it with PUT /api/projects/:id/config.`;
  },
};

const updateInputSchema = z
  .object({
    projectId: z.uuid(),
    patch: z
      .strictObject(
        {
          name: z.string().trim().min(1).max(200).optional(),
          baseBranch: z.string().trim().max(100).nullable().optional(),
          workspaceSetup: z.string().trim().max(8000).nullable().optional(),
        },
        UNDECLARED_PATCH_KEY,
      )
      .refine((o) => Object.values(o).some((v) => v !== undefined), {
        message: 'patch must have at least one defined field',
      }),
  })
  .strict();

/**
 * Update a project's settings (name/baseBranch/workspaceSetup) — the subset of `updateProjectSchema` that's safe to
 * expose to MCP. Sensitive fields (webhookSecret, apiKey, agentConfig) intentionally stay on the REST handler.
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
    "Update project settings (name, baseBranch, workspaceSetup). A checkout is not a project setting: it is the device binding's (`forge-runner bind <slug> --path <dir>`). Whether the project's work lands in git (`source.type`), its environments, promotions, deployments and testing profiles are NOT settings here: they are its project document, read with forge_config (action `get`, field `projectDocument`) and written with PUT /api/projects/:id/config, and a patch naming any other key is refused by name. Caller must be org owner/admin on the project's org (a merely-invited project admin cannot mutate settings — matches REST PATCH /api/projects/:id). PAT principals must additionally carry the `write` scope. `workspaceSetup` is prose describing how to bring this repo's workspace to a state a stage can build, test and commit in (install commands, hook setup, toolchain quirks) — the runner's setup agent reads it before every stage that lands in a broken workspace, so writing it once retires a per-job derivation. Record only a procedure you actually ran; null clears it. Sensitive fields (webhookSecret, apiKey, agentConfig) stay on REST.",
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
    if (input.patch.baseBranch !== undefined) updates.baseBranch = input.patch.baseBranch;
    if (input.patch.workspaceSetup !== undefined) {
      updates.workspaceSetup = input.patch.workspaceSetup;
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
    'Fetch project detail visible to the principal — id, slug, name, orgId, createdBy, role (effective: admin|member|viewer), workspaceSetup, baseBranch (where an ISS-* branch is cut from, NOT a release fact), createdAt. A checkout path is not a project fact: every device binding names its own. Where work lands, what each environment is and deploys from, its address and the testing profile its testers get in through are the project document — forge_config (action `get`, field `projectDocument`) — and what an environment runs now is GET /api/projects/:id/environments/:name/state. `workspaceSetup` is the project-declared setup procedure (install commands, hook setup, toolchain quirks) — follow it rather than guessing when a checkout will not build, and if it is null and you establish one, record it via forge_projects.update. Any effective project role can read. PAT principals must carry the `read` scope. Sensitive fields (agentConfig, webhookSecret, apiKey) stay on REST.',
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

    return {
      project: {
        id: proj.id,
        slug: proj.slug,
        name: proj.name,
        orgId: proj.orgId,
        createdBy: proj.createdBy,
        role,
        workspaceSetup: proj.workspaceSetup,
        baseBranch: proj.baseBranch,
        createdAt: proj.createdAt,
      },
    };
  },
});
