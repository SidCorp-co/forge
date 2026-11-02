import { HTTPException } from 'hono/http-exception';
import type { ContextScopedMcpToolFactory, McpContext } from '../lib/tool.js';
import { byRule, onResolved } from '../permissions/index.js';
import { readBus } from './link-read.js';
import {
  ACTIONS,
  type Action,
  ECOSYSTEM_ACTION_INPUTS,
  isWrite,
  parse,
  READS,
  WRITES,
} from './tool-args.js';
import { type Answer, HANDLERS, one, refusedWith } from './tool-handlers.js';
import { namedRefusals, type SideCodes, sideOf } from './tool-side.js';
import { DESCRIPTION, INPUT_SCHEMA } from './tool-text.js';

const SIDE_CODES: SideCodes = {
  invalid: 'ECOSYSTEM_ARGUMENT_INVALID',
  unbound: 'ECOSYSTEM_TURN_UNBOUND',
  unnamed: 'ECOSYSTEM_PROJECT_UNNAMED',
  outside: 'ECOSYSTEM_PROJECT_OUTSIDE_TOKEN',
};

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

// the reads whose REST twins declare project.read on :id (project-routes.ts, link-routes.ts), on the
// side the handler resolves (projectId, a token bound to one project, or the slug header), each
// checked with requireDeclaredOn. The rest are declared by the rule that decides them, with no floor,
// since a floor would answer before their named refusals: link by the row (its provider, the
// ecosystem's members), the writes by permissionFactsOf rules on the input or the row (the provider
// writer, the commitments setter, the consuming project's own agent), and bus by the ecosystem's
// steward or member
const THE_SIDE =
  "the projectId argument, else the token's one project or the X-Forge-Project-Slug header";
const OWN_AGENT =
  "the consuming project's own agent writes its record, decided on the input and the row";
const PERMISSION = {
  byAction: {
    interface: onResolved('project.read', THE_SIDE),
    links: onResolved('project.read', THE_SIDE),
    builder_runs: onResolved('project.read', THE_SIDE),
    builder_run: onResolved('project.read', THE_SIDE),
    context: onResolved('project.read', THE_SIDE),
    link: byRule(
      'ecosystem/link-read.ts:readLinkAs',
      "the link's row decides: its provider or consumer side, or a member of its ecosystem",
    ),
    interface_write: byRule(
      'ecosystem/provider-writer-rules.ts:providerWriterRefusal',
      'a holder of contracts.write, and commitments.write to change windows already set',
    ),
    link_create: byRule('ecosystem/link-service.ts:createLink', OWN_AGENT),
    link_update: byRule('ecosystem/link-service.ts:updateLink', OWN_AGENT),
    builder_run_create: byRule('ecosystem/link-service.ts:createBuilderRun', OWN_AGENT),
    builder_run_update: byRule('ecosystem/link-service.ts:updateBuilderRun', OWN_AGENT),
    builder_run_supersede: byRule(
      'ecosystem/builder-supersede.ts:supersedeBuilderRun',
      "the project's own agent, or an org admin of the steward or of the project's org",
    ),
    contract_version_publish: byRule(
      'ecosystem/contract/publish.ts:publishContractVersion',
      'the provider writer rule of interface_write, on the project that publishes',
    ),
    contract_version_decide: byRule(
      'ecosystem/contract/decide.ts:decideContractVersion',
      'a holder of contracts.approve on the publishing project, person or agent',
    ),
    bus: byRule(
      'ecosystem/membership-service.ts:readableEcosystem',
      "the ecosystem's steward or one of its members; it names no project",
    ),
  },
} as const;

const BUS_REACH = "an ecosystem's bus spans every member project, not the one a token reaches";
// each action takes the permission its REST route takes: the project's records are projects:*, and the bus is the account-wide ecosystems:read a project-fenced token does not reach, on /mcp as on REST
export const forgeEcosystemTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_ecosystem',
  description: DESCRIPTION,
  inputSchema: INPUT_SCHEMA,
  actionInputs: ECOSYSTEM_ACTION_INPUTS,
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
  permission: PERMISSION,
  handler: (raw) => run(ctx, raw),
});
export { forgeChannelTool } from './channel-tool.js';
