import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadInterface, writeInterface } from '../../ecosystem/interface-service.js';
import {
  listBuilderRunsAs,
  listLinksAs,
  readBuilderRunAs,
  readBus,
  readLinkAs,
  recordView,
} from '../../ecosystem/link-read.js';
import {
  createBuilderRun,
  createLink,
  type RecordOutcome,
  updateBuilderRun,
  updateLink,
} from '../../ecosystem/link-service.js';
import type { EcosystemRefusal } from '../../ecosystem/refusals.js';
import { assertProjectAccess } from '../../lib/authz.js';
import { namedRefusals, type SideCodes, sideOf } from './ecosystem-side.js';
import type { ContextScopedMcpToolFactory, McpContext } from './lib.js';

const READS = ['interface', 'links', 'link', 'builder_runs', 'builder_run', 'bus'] as const;
const WRITES = [
  'interface_write',
  'link_create',
  'link_update',
  'builder_run_create',
  'builder_run_update',
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
  interface_write: z.strictObject(envelope),
  link_create: z.strictObject(envelope),
  link_update: z.strictObject({ link: z.uuid(), ...envelope }),
  builder_run_create: z.strictObject(envelope),
  builder_run_update: z.strictObject({ run: z.uuid(), ...envelope }),
} satisfies Record<Action, z.ZodType>;

const SHAPES: Record<Action, string> = {
  interface: '{}',
  links: '{}',
  link: '{ link: a link uuid }',
  builder_runs: '{}',
  builder_run: '{ run: a builder run uuid }',
  bus: '{ ecosystem: an ecosystem uuid }',
  interface_write: '{ baseRevision: the revision read, or null for a first write, document }',
  link_create: '{ baseRevision: null, document: a link-v1 document }',
  link_update: '{ link, baseRevision, document: a link-v1 document }',
  builder_run_create: '{ baseRevision: null, document: a builder-run-v1 document }',
  builder_run_update: '{ run, baseRevision, document: a builder-run-v1 document }',
};

type Answer = Record<string, unknown>;

const refusedWith = (refusals: readonly EcosystemRefusal[]): Answer => ({
  _mcpIsError: true,
  error: {
    code: refusals.length === 1 ? refusals[0]?.code : 'ECOSYSTEM_REFUSED',
    message: `refused, nothing written: ${refusals.map((r) => `${r.code} at ${r.path || '/'}`).join('; ')}`,
    refusals,
  },
});

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

type Args = Record<string, unknown> & { baseRevision?: number | null; document?: unknown };

// cm:why every service here is the one its REST route calls, so the door changes and the rule does not: the writer is the token's own user and agency, never a field of the document
const HANDLERS: Record<
  Exclude<Action, 'bus'>,
  (ctx: McpContext, side: string, a: Args) => Promise<Answer>
> = {
  interface: async (ctx, side) => {
    await assertProjectAccess(side, ctx.principal.userId, 'viewer');
    const held = await loadInterface(side);
    return held
      ? { declared: true, revision: held.revision, document: held.document }
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
  interface_write: async (ctx, side, a) => {
    await assertProjectAccess(side, ctx.principal.userId, 'admin');
    const outcome = await writeInterface({
      projectId: side,
      userId: ctx.principal.userId,
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
};

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
  bus: '/ecosystem',
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
  'Reads: interface, links, link, builder_runs, builder_run, bus (an ecosystem as this token may see it; each link carries impact: whether the latest version of its contract version passes or breaks it, naming the fields, call sites and outside-contract surface it breaks).',
  "Writes take { baseRevision, document } as their REST route does: interface_write (an admin), link_create and link_update (link-v1, only by the consuming project's own agent), builder_run_create and builder_run_update (builder-run-v1; a join or a push opens the run itself, so a master updates the open one, and a finished run's answer carries report.declaredWithoutCallSite).",
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
    run: prop('builder_run, builder_run_update: the builder run uuid.'),
    ecosystem: prop('bus: the ecosystem uuid.'),
    baseRevision: prop('A write: the revision this was read at, or null for a first write.', {
      type: ['integer', 'null'],
    }),
    document: prop('A write: the whole document.', { type: 'object' }),
  },
  required: ['action'],
  additionalProperties: false,
};

// cm:why each action takes the permission its REST route takes: the project's records are projects:*, and the bus is the account-wide ecosystems:read a project-fenced token does not reach, on /mcp as on REST
export const forgeEcosystemTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_ecosystem',
  description: DESCRIPTION,
  inputSchema: INPUT_SCHEMA,
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
      bus: {
        account: "an ecosystem's bus spans every member project, not the one a token reaches",
      },
    } as Record<Action, 'project' | { account: string }>,
  },
  handler: (raw) => run(ctx, raw),
});
