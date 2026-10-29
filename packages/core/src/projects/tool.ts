// `forge_projects`: the projects a token reads, one in full, and a new one (ISS-767), each over the
// service its REST door calls (`projects/routes.ts`), so an MCP client can find the project it works
// in and set one up. Reached as the `projects.*` actions through forge_call (ISS-773).

import { scrubSecretsDeep } from '@forge/observability';
import { z } from 'zod';
import {
  assertUnfenced,
  loadProjectAccess,
  maxProjectRole,
  orgDerivedProjectRole,
} from '../lib/authz.js';
import { RefusalError, requestRefusals } from '../lib/refusal.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  patEffectiveProjectIds,
  zodToMcpSchema,
} from '../lib/tool.js';
import { need } from '../lib/tool-args.js';
import { findPersonalOrgId } from '../orgs/index.js';
import { actorFor, orgResource, requireHeld, requireOrgCan } from '../permissions/index.js';
import { readDeclaredSource } from '../project-config/index.js';
import { listVisibleProjectRows, projectDetail } from './read.js';
import { createProjectSchema } from './request-schemas.js';
import { createProject } from './service.js';

export const PROJECTS_TOOL_READS = ['list', 'get'] as const;
const ACTIONS = [...PROJECTS_TOOL_READS, 'create'] as const;

const input = z.strictObject({
  action: z.enum(ACTIONS),
  projectId: z.uuid().optional().describe('get: the project'),
  archived: z.boolean().optional().describe('list: archived projects too'),
  slug: createProjectSchema.shape.slug.optional(),
  name: createProjectSchema.shape.name.optional(),
  orgId: z.uuid().optional().describe('create: the org; your personal org when omitted'),
});
type Input = z.infer<typeof input>;

const SHAPE = '{ action, projectId?, archived?, slug?, name?, orgId? }';

const DESCRIPTION = `The projects you can read, one in full, and a new one, as their REST doors answer them.
- list { archived? }: every project you can read, each with its id, slug, name and your role. Start here to find the project you work in.
- get { projectId }: one project with your role, its members, labels and base branch.
- create { slug, name, orgId? }: a new project in your personal org, or in the org named where you hold a role in it, as POST /api/projects creates one; a token fenced to projects is refused, since a new project is in none of them.`;

const parse = (args: unknown): Input => {
  const parsed = input.safeParse(args);
  if (parsed.success) return parsed.data;
  throw new RefusalError(requestRefusals('BAD_REQUEST', SHAPE, parsed.error), 'BAD_REQUEST', SHAPE);
};

async function list(ctx: McpContext, i: Input) {
  const fence = patEffectiveProjectIds(ctx.principal);
  const rows = await listVisibleProjectRows(ctx.principal.userId, i.archived === true);
  const shown = fence === null ? rows : rows.filter((r) => fence.includes(r.id));
  return {
    returned: shown.length,
    projects: shown.map(({ memberRole, orgRole, ...row }) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      archivedAt: (row as { archivedAt?: unknown }).archivedAt ?? null,
      role: maxProjectRole(memberRole ?? null, orgDerivedProjectRole(orgRole ?? null)),
      orgRole: orgRole ?? null,
    })),
  };
}

async function get(ctx: McpContext, i: Input) {
  const { projectId } = need(i, 'get', 'projectId');
  const access = await loadProjectAccess(projectId, ctx.principal.userId);
  requireHeld(access, 'project.read');
  const detail = await projectDetail(projectId);
  if (!detail) throw new Error(`NOT_FOUND: project ${projectId} not found`);
  return {
    ...detail.project,
    baseBranch: (await readDeclaredSource(projectId)).defaultBranch,
    role: access.role,
    orgRole: access.orgRole,
    members: detail.members,
    labels: detail.labels,
  };
}

async function create(ctx: McpContext, i: Input) {
  assertUnfenced('creating a project');
  const { slug, name } = need(i, 'create', 'slug', 'name');
  const userId = ctx.principal.userId;
  let orgId: string;
  if (i.orgId) {
    await requireOrgCan(actorFor(userId), 'org.read', orgResource(i.orgId));
    orgId = i.orgId;
  } else {
    const personal = await findPersonalOrgId(userId);
    if (!personal) throw new Error('personal org missing — run migrations');
    orgId = personal;
  }
  return createProject({ slug, name, orgId, createdBy: userId });
}

export const forgeProjectsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_projects',
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(input),
  route: '/api/projects',
  grant: { byAction: { list: 'projects:read', get: 'projects:read', create: 'projects:write' } },
  reach: {
    byAction: {
      list: 'project',
      get: 'project',
      create: {
        account:
          'a new project is created in an org, inside none of the projects a token is fenced to',
      },
    },
  },
  // a project's record carries what people wrote, so a credential pasted into it never leaves
  handler: async (args) => {
    const i = parse(args);
    if (i.action === 'list') return scrubSecretsDeep(await list(ctx, i));
    if (i.action === 'get') return scrubSecretsDeep(await get(ctx, i));
    return scrubSecretsDeep(await create(ctx, i));
  },
});
