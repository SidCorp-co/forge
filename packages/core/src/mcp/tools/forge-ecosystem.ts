import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { agentSessions } from '../../db/schema.js';
import { supersedeBuilderRun } from '../../ecosystem/builder-supersede.js';
import {
  CONTRACT_DECISION_REASON_MAX,
  CONTRACT_DECISIONS,
  type ContractDecision,
} from '../../ecosystem/contract/approval.js';
import { decideContractVersion } from '../../ecosystem/contract/decide.js';
import { MAX_ARTIFACT_BYTES } from '../../ecosystem/contract/measure.js';
import { publishContractVersion } from '../../ecosystem/contract/publish.js';
import {
  loadContractContext,
  recordContractContext,
} from '../../ecosystem/contract/run-context-service.js';
import { approvalView } from '../../ecosystem/contract/store.js';
import { SOURCE_REF } from '../../ecosystem/contract/version-schema.js';
import {
  commitmentsSetter,
  loadInterface,
  writeInterface,
} from '../../ecosystem/interface-service.js';
import {
  listBuilderRunsAs,
  listLinksAs,
  readBuilderRunAs,
  readBus,
  readLinkAs,
  recordView,
} from '../../ecosystem/link-read.js';
import { repoPath } from '../../ecosystem/link-schema.js';
import {
  createBuilderRun,
  createLink,
  type RecordOutcome,
  updateBuilderRun,
  updateLink,
} from '../../ecosystem/link-service.js';
import type { EcosystemRefusal } from '../../ecosystem/refusals.js';
import { projectsWhere } from '../../ecosystem/store.js';
import {
  WAIT_BY_ACTION,
  WAIT_DESCRIPTION,
  WAIT_HANDLERS,
  WAIT_PROPERTIES,
  WAIT_READS,
  WAIT_SHAPES,
  WAIT_WRITES,
} from './ecosystem-contract-waits.js';
import { namedRefusals, type SideCodes, sideOf } from './ecosystem-side.js';
import { type ContextScopedMcpToolFactory, type McpContext, refusedAnswer } from './lib.js';
import { requireCan } from '../../permissions/index.js';

const READS = [
  'interface',
  'links',
  'link',
  'builder_runs',
  'builder_run',
  'bus',
  'context',
  ...WAIT_READS,
] as const;
const WRITES = [
  'interface_write',
  'link_create',
  'link_update',
  'builder_run_create',
  'builder_run_update',
  'builder_run_supersede',
  'contract_version_publish',
  'contract_version_decide',
  ...WAIT_WRITES,
] as const;
const ACTIONS = [...READS, ...WRITES] as const;
type Action = (typeof ACTIONS)[number];

const envelope = {
  baseRevision: z.number().int().min(1).nullable(),
  document: z.unknown().refine((v) => v !== undefined, 'document is required'),
};

/** What each action takes; a key another action takes is refused here, not dropped. */
const BY_ACTION = {
  interface: z.strictObject({}),
  links: z.strictObject({}),
  link: z.strictObject({ link: z.uuid() }),
  builder_runs: z.strictObject({}),
  builder_run: z.strictObject({ run: z.uuid() }),
  bus: z.strictObject({ ecosystem: z.uuid() }),
  context: z.strictObject({
    paths: z.array(repoPath()).min(1).max(200),
    session: z.uuid().optional(),
  }),
  interface_write: z.strictObject(envelope),
  link_create: z.strictObject(envelope),
  link_update: z.strictObject({ link: z.uuid(), ...envelope }),
  builder_run_create: z.strictObject(envelope),
  builder_run_update: z.strictObject({ run: z.uuid(), ...envelope }),
  builder_run_supersede: z.strictObject({ run: z.uuid(), reason: z.unknown().optional() }),
  contract_version_publish: z.strictObject({
    contract: z
      .string()
      .regex(
        /^(?:[a-z][a-z0-9-]{0,62}\/)?[a-z][a-z0-9-]{0,62}$/,
        'contract is the publication slug, or <this project slug>/<slug>',
      ),
    version: z.string().min(1).max(40),
    kind: z.string().min(1).max(40),
    source: z.union([z.string().min(1).max(MAX_ARTIFACT_BYTES), z.record(z.string(), z.unknown())]),
    sourceRef: z
      .string()
      .regex(
        SOURCE_REF,
        'sourceRef is <repository path>@<commit sha>, e.g. schema.graphql@1a2b3c4',
      ),
  }),
  contract_version_decide: z.strictObject({
    contract: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'contract is the publication slug'),
    version: z.string().min(1).max(40),
    decision: z.enum(CONTRACT_DECISIONS),
    reason: z.string().max(CONTRACT_DECISION_REASON_MAX).optional(),
  }),
  ...WAIT_BY_ACTION,
} satisfies Record<Action, z.ZodType>;

const SHAPES: Record<Action, string> = {
  interface: '{}',
  links: '{}',
  link: '{ link: a link uuid }',
  builder_runs: '{}',
  builder_run: '{ run: a builder run uuid }',
  bus: '{ ecosystem: an ecosystem uuid }',
  context:
    '{ paths: the repository paths this run touches, session?: the agent session to record the load on }',
  interface_write: '{ baseRevision: the revision read, or null for a first write, document }',
  link_create: '{ baseRevision: null, document: a link-v1 document }',
  link_update: '{ link, baseRevision, document: a link-v1 document }',
  builder_run_create: '{ baseRevision: null, document: a builder-run-v1 document }',
  builder_run_update: '{ run, baseRevision, document: a builder-run-v1 document }',
  builder_run_supersede: '{ run: the open builder run uuid, reason: why it is replaced }',
  contract_version_publish:
    '{ contract: the publication slug, version, kind: graphql | mcp-tools | openapi | json-schema, source: SDL text or the { tools } JSON, sourceRef: <repo path>@<sha> }',
  contract_version_decide:
    '{ contract: the publication slug, version: a proposed version, decision: approve | return, reason?: why, required to return }',
  ...WAIT_SHAPES,
};

type Answer = Record<string, unknown>;

const refusedWith = (refusals: readonly EcosystemRefusal[]): Answer =>
  refusedAnswer(refusals, 'ECOSYSTEM_REFUSED');

const one = (code: EcosystemRefusal['code'], path: string, detail: string) =>
  refusedWith([{ code, path, detail }]);

const SIDE_CODES: SideCodes = {
  invalid: 'ECOSYSTEM_ARGUMENT_INVALID',
  unbound: 'ECOSYSTEM_TURN_UNBOUND',
  unnamed: 'ECOSYSTEM_PROJECT_UNNAMED',
  outside: 'ECOSYSTEM_PROJECT_OUTSIDE_TOKEN',
};

type Parsed =
  | { ok: true; action: Action; args: Record<string, unknown> }
  | { ok: false; refusals: EcosystemRefusal[] };

function parse(raw: Record<string, unknown>): Parsed {
  const { action, ...rest } = raw;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      refusals: [
        {
          code: 'ECOSYSTEM_ARGUMENT_INVALID',
          path: '/action',
          detail: `action is one of ${ACTIONS.join(', ')}`,
        },
      ],
    };
  }
  const act = action as Action;
  const parsed = BY_ACTION[act].safeParse(rest);
  if (parsed.success) return { ok: true, action: act, args: parsed.data };
  return {
    ok: false,
    refusals: parsed.error.issues.map((issue) => {
      const keys = issue.code === 'unrecognized_keys' ? issue.keys : [];
      return {
        code: 'ECOSYSTEM_ARGUMENT_INVALID',
        path: `/${[...issue.path, ...keys.slice(0, 1)].map(String).join('/')}`,
        detail: `${act} takes ${SHAPES[act]}; ${issue.message}`,
      };
    }),
  };
}

const isWrite = (a: Action) => (WRITES as readonly string[]).includes(a);

function recorded<W extends object>(outcome: RecordOutcome<W>): Answer {
  if (!outcome.ok) return refusedWith(outcome.refusals);
  const report = outcome.report ? { report: outcome.report } : {};
  return { ...recordView(outcome.held), created: outcome.created, ...report };
}

async function sessionOf(projectId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.projectId, projectId)))
    .limit(1);
  return Boolean(row);
}

type Args = Record<string, unknown> & { baseRevision?: number | null; document?: unknown };

// cm:why every service here is the one its REST route calls, so the door changes and the rule does not: the writer is the token's own user and agency, never a field of the document
const HANDLERS: Record<
  Exclude<Action, 'bus'>,
  (ctx: McpContext, side: string, a: Args) => Promise<Answer>
> = {
  interface: async (ctx, side) => {
    await requireCan({ userId: ctx.principal.userId }, 'project.read', side);
    const held = await loadInterface(side);
    return held
      ? {
          declared: true,
          revision: held.revision,
          document: held.document,
          commitmentsSetBy: await commitmentsSetter(side),
        }
      : { declared: false, revision: null, document: null };
  },
  links: async (ctx, side) => {
    const links = await listLinksAs(ctx.principal.userId, side);
    return { links, returned: links.length };
  },
  link: async (ctx, side, a) => readLinkAs(ctx.principal.userId, side, String(a.link)),
  builder_runs: async (ctx, side) => {
    const runs = await listBuilderRunsAs(ctx.principal.userId, side);
    return { runs, returned: runs.length };
  },
  builder_run: async (ctx, side, a) => readBuilderRunAs(ctx.principal.userId, side, String(a.run)),
  context: async (ctx, side, a) => {
    await requireCan({ userId: ctx.principal.userId }, 'project.read', side);
    const session = typeof a.session === 'string' ? a.session : null;
    if (session && !(await sessionOf(side, session))) {
      return one(
        'ECOSYSTEM_RECORD_NOT_FOUND',
        '/session',
        `project ${side} holds no agent session ${session}`,
      );
    }
    const loaded = await loadContractContext(side, a.paths as string[]);
    if (session && loaded.length) await recordContractContext(session, loaded, 'agent');
    return { loaded, returned: loaded.length, recorded: Boolean(session && loaded.length) };
  },
  interface_write: async (ctx, side, a) => {
    const outcome = await writeInterface({
      projectId: side,
      writer: { userId: ctx.principal.userId, agency: ctx.principal.agency },
      baseRevision: a.baseRevision ?? null,
      raw: a.document,
    });
    if (!outcome.ok) return refusedWith(outcome.refusals);
    const { held } = outcome;
    return {
      declared: true,
      revision: held.revision,
      document: held.document,
      created: outcome.created,
      commitmentsSetBy: await commitmentsSetter(side),
    };
  },
  contract_version_publish: async (ctx, side, a) => publish(ctx, side, a),
  contract_version_decide: async (ctx, side, a) => {
    const out = await decideContractVersion({
      projectId: side,
      contract: String(a.contract),
      version: String(a.version),
      decision: a.decision as ContractDecision,
      reason: typeof a.reason === 'string' ? a.reason : null,
      actor: { userId: ctx.principal.userId, agency: ctx.principal.agency },
    });
    if (!out.ok) return refusedWith(out.refusals);
    return {
      version: out.version.document,
      approval: approvalView(out.version),
      settledWaits: out.settled.length,
      filedFeedback: out.filed.length,
    };
  },
  link_create: async (ctx, side, a) =>
    recorded(await createLink({ projectId: side, ...writeOf(ctx, a) })),
  link_update: async (ctx, side, a) =>
    recorded(await updateLink({ projectId: side, id: String(a.link), ...writeOf(ctx, a) })),
  builder_run_create: async (ctx, side, a) =>
    recorded(await createBuilderRun({ projectId: side, ...writeOf(ctx, a) })),
  builder_run_update: async (ctx, side, a) =>
    recorded(await updateBuilderRun({ projectId: side, id: String(a.run), ...writeOf(ctx, a) })),
  ...WAIT_HANDLERS,
  builder_run_supersede: async (ctx, side, a) => {
    const outcome = await supersedeBuilderRun({
      runId: String(a.run),
      projectId: side,
      actor: { userId: ctx.principal.userId, agency: ctx.principal.agency },
      reason: a.reason,
    });
    if (!outcome.ok) return refusedWith(outcome.refusals);
    return { superseded: recordView(outcome.superseded), opened: recordView(outcome.opened) };
  },
};

async function publish(ctx: McpContext, side: string, a: Args): Promise<Answer> {
  const own = await loadSlug(side);
  const raw = String(a.contract);
  const slash = raw.indexOf('/');
  if (slash >= 0 && raw.slice(0, slash) !== own) {
    return one(
      'CONTRACT_NOT_PUBLISHED',
      '/contract',
      `${raw} names project ${raw.slice(0, slash)}; a project publishes versions of its own contracts only, and this call acts for ${own ?? side}`,
    );
  }
  const out = await publishContractVersion({
    projectId: side,
    writer: { userId: ctx.principal.userId, agency: ctx.principal.agency },
    contract: raw.slice(slash + 1),
    kind: String(a.kind),
    version: String(a.version),
    artifact: typeof a.source === 'string' ? a.source : JSON.stringify(a.source),
    sourceRef: String(a.sourceRef),
  });
  if (!out.ok) {
    return refusedWith(
      out.refusals.map((r) => (r.path === '/artifact' ? { ...r, path: '/source' } : r)),
    );
  }
  return { recorded: out.recorded, version: out.version };
}

async function loadSlug(projectId: string): Promise<string | null> {
  const [row] = await projectsWhere(db, { ids: [projectId] });
  return row?.slug ?? null;
}

const writeOf = (ctx: McpContext, a: Args) => ({
  writer: { userId: ctx.principal.userId, agency: ctx.principal.agency },
  baseRevision: a.baseRevision ?? null,
  raw: a.document,
});

const PATH_OF: Partial<Record<Action, string>> = {
  link: '/link',
  link_update: '/link',
  builder_run: '/run',
  builder_run_update: '/run',
  builder_run_supersede: '/run',
  context: '/session',
  bus: '/ecosystem',
  contract_version_publish: '/contract',
  contract_version_decide: '/version',
};

async function run(ctx: McpContext, raw: Record<string, unknown>): Promise<Answer> {
  const { projectId: named, ...rest } = raw;
  const call = parse(rest);
  if (!call.ok) return refusedWith(call.refusals);
  const { action, args } = call;
  let side: string | null = null;
  if (action === 'bus' && named !== undefined) {
    return one(
      'ECOSYSTEM_ARGUMENT_INVALID',
      '/projectId',
      'bus reads an ecosystem, not a project; name it by ecosystem',
    );
  }
  if (action !== 'bus') {
    const resolved = await sideOf(ctx, named, SIDE_CODES);
    if (!resolved.ok) return refusedWith([resolved.refusal]);
    side = resolved.side;
  }
  if (isWrite(call.action) && !ctx.principal.scopes.includes('write')) {
    return one(
      'ECOSYSTEM_WRITE_NOT_AUTHORISED',
      '/action',
      `${call.action} writes, and the token this call runs under lacks the 'write' scope`,
    );
  }
  try {
    if (action === 'bus') return await readBus(ctx.principal.userId, String(args.ecosystem));
    return await HANDLERS[action](ctx, side as string, args);
  } catch (err) {
    const decided = namedRefusals(err);
    if (decided) return refusedWith(decided);
    if (err instanceof HTTPException && err.status === 404) {
      return one('ECOSYSTEM_RECORD_NOT_FOUND', PATH_OF[call.action] ?? '/', err.message);
    }
    if (err instanceof HTTPException && err.status === 403) {
      return one(
        'ECOSYSTEM_NOT_AUTHORISED',
        PATH_OF[call.action] ?? '/projectId',
        `${call.action}${side ? ` on project ${side}` : ''} is refused: ${err.message}`,
      );
    }
    throw err;
  }
}

const DESCRIPTION = [
  "Read and write a project's ecosystem records: its interface, the links its own code holds to the contracts it consumes, its builder runs, and an ecosystem's bus.",
  'Reads: interface, links, link, builder_runs, builder_run, context (the contracts a run touching { paths } calls: per link with a call site under a path, its guide notes and the measured diff from its pinned version to the latest; recorded on { session } when named), bus (an ecosystem as this token may see it; each link carries impact: whether the latest version of its contract version passes or breaks it, naming the fields, call sites and outside-contract surface it breaks).',
  "Writes take { baseRevision, document } as their REST route does: interface_write (the project's own agent, member or above, or a person holding admin; commitment windows an agent writes read as set by the agent, and once a person has set them an agent's write that moves them is refused COMMITMENTS_SET_BY_PERSON), link_create and link_update (link-v1, only by the consuming project's own agent), builder_run_create and builder_run_update (builder-run-v1; a join or a push opens the run itself, so a master updates the open one, and a finished run's answer carries report.declaredWithoutCallSite), builder_run_supersede ({ run, reason }: closes an open run as superseded and opens a fresh manual run with the steps the project's current source type derives, waking its master; the project's own agent's, or an org admin's of the steward or the project's org).",
  "contract_version_publish ({ contract, version, kind, source, sourceRef }, POST /api/projects/:id/contracts/:contract/versions on REST) records a version of a contract this project publishes with artifact { upload: true }: kind is graphql (SDL text), mcp-tools ({ tools: [{ name, inputSchema }] }), openapi or json-schema, and must be the publication's type; core indexes its elements and measures it against the latest version. Refused by name: CONTRACT_KIND_UNKNOWN, CONTRACT_KIND_MISMATCH, ARTIFACT_UNREADABLE, VERSION_BUMP_TOO_SMALL, VERSION_NOT_IN_SCHEME, CONTRACT_NOT_PUBLISHED, CONTRACT_WRITER_NOT_PROVIDER (the writer rule of interface_write).",
  'contract_version_decide ({ contract, version, decision: approve | return, reason? }, POST /api/projects/:id/contracts/:contract/versions/:version/decision on REST) decides a proposed version: a recorded version is proposed, and current only once approved. Whoever holds contracts.approve (project admin, or an org owner or admin), person or agent alike decides any version, breaking included. Refused by name: PERMISSION_FORBIDDEN, CONTRACT_VERSION_NOT_PROPOSED, CONTRACT_DECISION_REASON_MISSING.',
  WAIT_DESCRIPTION,
  "The writer is the token, never a field of the document. A refusal comes back as { code, path, detail } under the service's own code, nothing written.",
  'For the channel, use forge_channel.',
].join(' ');

const prop = (description: string, schema: Record<string, unknown> = { type: 'string' }) => ({
  ...schema,
  description,
});

const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    projectId: prop(
      'The project acted for; a token bound to one project, or the X-Forge-Project-Slug header, names it when omitted.',
    ),
    link: prop('link, link_update: the link uuid.'),
    run: prop('builder_run, builder_run_update, builder_run_supersede: the builder run uuid.'),
    reason: prop(
      'builder_run_supersede: why the open run is replaced, 1 to 1000 characters. contract_version_decide: why, required to return. contract_wait_add: why it waits, optional. contract_wait_retract: why it no longer waits.',
    ),
    decision: prop('contract_version_decide: approve or return.', {
      type: 'string',
      enum: [...CONTRACT_DECISIONS],
    }),
    ecosystem: prop('bus: the ecosystem uuid.'),
    contract: prop(
      'contract_version_publish, contract_version_decide: the publication slug of a contract this project publishes. contract_wait_add: <provider slug>/<publication slug> of another project.',
    ),
    version: prop(
      'contract_version_publish: the version name, in the interface versioning scheme, after the latest.',
    ),
    kind: prop(
      'contract_version_publish: graphql, mcp-tools, openapi or json-schema; the publication type.',
    ),
    source: prop(
      'contract_version_publish: the artifact, SDL text for graphql, the { tools } JSON for mcp-tools.',
      {
        type: ['string', 'object'],
      },
    ),
    sourceRef: prop(
      'contract_version_publish: where the artifact was read, <repository path>@<commit sha>.',
    ),
    paths: prop('context: repository-relative paths the run touches.', {
      type: 'array',
      items: { type: 'string' },
    }),
    session: prop('context: the agent session uuid to record what was loaded on.'),
    baseRevision: prop('A write: the revision this was read at, or null for a first write.', {
      type: ['integer', 'null'],
    }),
    document: prop('A write: the whole document.', { type: 'object' }),
    ...WAIT_PROPERTIES,
  },
  required: ['action'],
  additionalProperties: false,
};

const BUS_REACH = "an ecosystem's bus spans every member project, not the one a token reaches";
// cm:why each action takes the permission its REST route takes: the project's records are projects:*, and the bus is the account-wide ecosystems:read a project-fenced token does not reach, on /mcp as on REST
export const forgeEcosystemTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_ecosystem',
  description: DESCRIPTION,
  inputSchema: INPUT_SCHEMA,
  route: ['/api/projects', '/api/ecosystems'],
  grant: {
    byAction: {
      ...Object.fromEntries(READS.map((a) => [a, 'projects:read' as const])),
      ...Object.fromEntries(WRITES.map((a) => [a, 'projects:write' as const])),
      bus: 'ecosystems:read',
    } as Record<Action, 'projects:read' | 'projects:write' | 'ecosystems:read'>,
  },
  reach: {
    byAction: {
      ...Object.fromEntries(ACTIONS.map((a) => [a, 'project' as const])),
      bus: { account: BUS_REACH },
    } as Record<Action, 'project' | { account: string }>,
  },
  handler: (raw) => run(ctx, raw),
});
