// `forge_projects`: the projects a token reads, one in full, and a new one (ISS-767), each over the
// service its REST door calls (`projects/routes.ts`), so an MCP client can find the project it works
// in and set one up. Reached as the `projects.*` actions through forge_call (ISS-773).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
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
  sourceOf,
  zodToMcpSchema,
} from '../lib/tool.js';
import { need } from '../lib/tool-args.js';
import { findPersonalOrgId } from '../orgs/index.js';
import {
  actorFor,
  byRule,
  orgResource,
  permissionless,
  requireHeld,
  requireOrgCan,
} from '../permissions/index.js';
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
- create { slug, name, orgId? }: a new project in your personal org, or in the org named where you hold a role in it, as POST /api/projects creates one; a token fenced to projects is refused, since a new project is in none of them. It holds a slug and a name only: config.write then sets the rest of it, its one-line description, its repository and branches and its environments, as a first write (baseRevision null).`;

/** What describe tells of create beyond its guide (REQ-78 BC-3). */
const DESCRIBE = {
  create: {
    fields: {
      slug: 'required: the project’s address, unique on this Forge: 3 to 64 lower-case letters, digits or hyphens, starting with a letter (shop, acme-web)',
      name: 'required: the project’s name as people read it',
      orgId: 'optional: the org it is created in; your personal org when left out',
    },
    example: { slug: 'shop', name: 'Shop' },
  },
} as const;

/** When a person's client reaches for the projects door (ISS-1251), from how product roles used it. */
const CARDS = {
  list: {
    purpose: 'Lists the projects you can read, each with its id, slug, name and your role in it.',
    situations: [
      {
        when: 'you start working for a person and do not yet hold the id of the project they mean',
        do: 'list and match their words to a slug or name; every other action takes that id as projectId',
      },
      {
        when: 'a person asks to set up a new project',
        do: 'list first: a project with that slug or name may already exist, archived ones with archived true',
      },
    ],
    practice: [
      'A token fenced to some projects lists only those; a project missing here is outside the token, not absent.',
    ],
    example: { archived: false },
    redFlag: 'Telling a person a project does not exist because a fenced token does not list it.',
    family: 'product.status',
    audience: ['person'],
    scenarios: ['a project matched by its slug before another is set up'],
  },
  get: {
    purpose: 'Reads one project: your role, its members, its labels and its base branch.',
    situations: [
      {
        when: 'a person asks who works on a project, what role they hold, or which branch it builds on',
        do: 'get it by its id and answer from members, role and baseBranch',
      },
    ],
    practice: [
      'Environments, repository and testing profiles are not here: config.get reads the project document.',
    ],
    example: { projectId: '<project uuid>' },
    redFlag:
      'Answering where a project deploys from get, which holds no environments: config.get reads them.',
    family: 'product.status',
    audience: ['person'],
    scenarios: ['a person asking who works on a project and which branch it builds on'],
  },
  create: {
    purpose:
      'Creates a new project from a slug and a name, in your personal org or one you belong to.',
    situations: [
      {
        when: 'a person asks to put a new product or repository on Forge and projects.list shows none for it',
        do: 'create it with slug and name, then config.write its description, repository, branches and environments',
      },
    ],
    practice: [
      'Create holds a slug and a name only; the first config.write (baseRevision null) sets the rest.',
      'A token fenced to projects is refused: a new project lies in none of them.',
    ],
    example: { slug: 'shop', name: 'Shop' },
    // FB-596 (gwork set up over MCP, 2026-11-09): the client read create's slug and name as all a
    // project holds and concluded its description and repository could not be set
    redFlag:
      'Stopping at slug and name as if that were the whole project: its description, repository and environments come from config.write.',
    family: 'setup',
    audience: ['person'],
    scenarios: ['gwork set up over MCP, its repository thought unsettable: FB-596'],
  },
} satisfies Record<(typeof ACTIONS)[number], CapabilityCardBody>;

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

/** forge_projects.get: its projectId argument's own refusal, then project.read on that project. */
export async function getProjectForTool(ctx: McpContext, i: Input) {
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

/** forge_projects.create: an unfenced token, and org.read on the org named, else the caller's own. */
export async function createProjectForTool(ctx: McpContext, i: Input) {
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
  actionDescribe: DESCRIBE,
  cards: CARDS,
  source: sourceOf(import.meta.url),
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
  // list reads only the projects the caller sees; get and create are declared by the rule that
  // decides them: get's missing projectId is refused by its own argument rule before project.read,
  // and create's org depends on the input
  permission: {
    byAction: {
      list: permissionless('self', 'the projects the caller can see, inside its token fence'),
      get: byRule(
        'projects/tool.ts:getProjectForTool',
        'project.read on the project projectId names, once its own argument rule has answered',
      ),
      create: byRule(
        'projects/tool.ts:createProjectForTool',
        "org.read on the org orgId names, else the caller's personal org, from an unfenced token",
      ),
    },
  },
  // a project's record carries what people wrote, so a credential pasted into it never leaves
  handler: async (args) => {
    const i = parse(args);
    if (i.action === 'list') return scrubSecretsDeep(await list(ctx, i));
    if (i.action === 'get') return scrubSecretsDeep(await getProjectForTool(ctx, i));
    return scrubSecretsDeep(await createProjectForTool(ctx, i));
  },
});
