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
import { readProjectConfig, writeProjectConfig } from '../../project-config/service.js';
import { retiredProjectFieldsMessage } from '../../projects/retired-project-keys.js';
import {
  createProject,
  ProjectSlugTakenError,
  readProjectSummary,
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
  reach: 'project',
  grant: 'projects:read',
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
    // Org tier — omitted = the caller's personal org.
    orgId: z.uuid().optional(),
  },
  undeclaredOrRetired('forge_projects.create', 'slug, name and orgId'),
);

export const forgeProjectsCreateTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects.create',
  reach: { account: 'creating a project' },
  grant: 'projects:write',
  description:
    "Create a new project in an org (orgId optional — defaults to the caller's personal org; the caller becomes a project admin). Accepts slug and name; the branch work is cut from is the project document's `source.git.defaultBranch`, and `baseBranch` is refused by name. A checkout is not a project setting: it is the device binding's (`forge-runner bind <slug> --path <dir>`). Where its work lands, its environments, promotions and deployments are its project document, written with PUT /api/projects/:id/config. PAT principals must carry the `write` scope and reach no narrower than their owner: a token fenced to projects, by a project list or a bound project, is refused with PAT_ACCOUNT_ROUTE. Returns id/slug/name/orgId/createdBy/createdAt.",
  inputSchema: zodToMcpSchema(createInputSchema),
  handler: async (args) => {
    const input = createInputSchema.parse(args);
    const { principal } = ctx;

    if (principal.kind === 'pat') {
      if (!principal.scopes.includes('write')) {
        throw new Error('FORBIDDEN_SCOPE: requires write scope on the PAT');
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
    return `forge_projects.update does not take ${keys.map((k) => `\`${k}\``).join(', ')}; its only field is name.${retired ? ` ${retired}` : ''} Whether a project's work lands in git (\`source.type\`), its environments, promotions, deployments and testing profiles are its project document: read it with forge_config (action \`get\`, field \`projectDocument\`) and write it with PUT /api/projects/:id/config.`;
  },
};

const updateInputSchema = z
  .object({
    projectId: z.uuid(),
    patch: z
      .strictObject(
        {
          name: z.string().trim().min(1).max(200).optional(),
        },
        UNDECLARED_PATCH_KEY,
      )
      .refine((o) => Object.values(o).some((v) => v !== undefined), {
        message: 'patch must have at least one defined field',
      }),
  })
  .strict();

/**
 * Rename a project. The name's one source is the project document's `project.name`, so this is a
 * project document write — the revision it read, every check a PUT /api/projects/:id/config makes,
 * and the `projects.name` projection in the same transaction — never a write to the column.
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
  reach: 'project',
  grant: 'projects:write',
  description:
    "Update project settings (name). The name is the project document's `project.name`: this writes that document at the revision it reads, with every check PUT /api/projects/:id/config makes, and a project with no document yet is refused PROJECT_NOT_DECLARED (declare one with PUT /api/projects/:id/config). A checkout is not a project setting: it is the device binding's (`forge-runner bind <slug> --path <dir>`). Whether the project's work lands in git (`source.type`), its environments, promotions, deployments and testing profiles are NOT settings here: they are its project document, read with forge_config (action `get`, field `projectDocument`) and written with PUT /api/projects/:id/config, and a patch naming any other key is refused by name. Caller must be org owner/admin on the project's org (a merely-invited project admin cannot mutate settings — matches REST PATCH /api/projects/:id). PAT principals must additionally carry the `write` scope. The repository and the workspace setup procedure are the project document's `source.git.repository` and `workspace.setup`: a patch naming `repoUrl`, `workspaceSetup` or `baseBranch` is refused by name. A project holds no webhook secret: each provider's webhook is verified with its integration binding's own.",
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

    const name = input.patch.name;
    const held = name === undefined ? null : await readProjectConfig(input.projectId);
    if (name !== undefined) {
      if (!held) {
        throw new Error(
          `BAD_REQUEST: PROJECT_NOT_DECLARED: project ${input.projectId} has no project document, and its name is that document's \`project.name\`; declare it with PUT /api/projects/:id/config { baseRevision: null, document }.`,
        );
      }
      const outcome = await writeProjectConfig({
        projectId: input.projectId,
        userId,
        baseRevision: held.revision,
        raw: { ...held.document, project: { ...held.document.project, name } },
      });
      if (!outcome.ok) {
        const codes = [...new Set(outcome.refusals.map((r) => r.code))].join(', ');
        throw new Error(
          `BAD_REQUEST: ${codes}: ${outcome.refusals.map((r) => `${r.code} at ${r.path || '/'}: ${r.detail}`).join('; ')}`,
        );
      }
    }
    const summary = await readProjectSummary(input.projectId);
    if (!summary) throw new Error('NOT_FOUND: project not found');
    return { project: summary };
  },
});

const getInputSchema = z.object({ projectId: z.uuid() }).strict();

export const forgeProjectsGetTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects.get',
  reach: 'project',
  grant: 'projects:read',
  description:
    'Fetch project detail visible to the principal — id, slug, name, orgId, createdBy, role (effective: admin|member|viewer), baseBranch (`source.git.defaultBranch` of the project document, where an ISS-* branch is cut from; null where the document declares none), createdAt. A checkout path is not a project fact: every device binding names its own. Where work lands, what each environment is and deploys from, its address and the testing profile its testers get in through are the project document — forge_config (action `get`, field `projectDocument`) — and what an environment runs now is GET /api/projects/:id/environments/:name/state. The repository and the setup procedure a checkout follows when it will not build are `source.git.repository` and `workspace.setup` in that document. Any effective project role can read. PAT principals must carry the `read` scope. agentConfig stays on REST.',
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
        baseBranch: proj.baseBranch,
        createdAt: proj.createdAt,
      },
    };
  },
});
