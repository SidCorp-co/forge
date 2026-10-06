import type { ChannelRefusalCode } from '@forge/contracts/ecosystem';
import { CHANNEL_ACTIONS, CHANNEL_WRITES, type ChannelAction } from '@forge/contracts/ecosystem';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { RefusalError } from '../lib/refusal.js';
import type { ContextScopedMcpToolFactory, McpContext } from '../lib/tool.js';
import { ecosystemReadFence } from './access.js';
import { readApiPage } from './api-page.js';
import type { ChannelOutcome } from './channel-act.js';
import { channelRoleRefusal, type Writer, writerOfPrincipal } from './channel-author.js';
import { supersede, withdraw } from './channel-ends.js';
import { holdOrRelease } from './channel-holds.js';
import { inbox, outbox, readAs, threadAs, unanswered } from './channel-read.js';
import { readRegister } from './channel-register.js';
import { UUID_PATTERN } from './channel-schema.js';
import { createDraft, editDraft, submit } from './channel-service.js';
import { CHANNEL_INPUT_SCHEMA, type ChannelArgs, parseChannelCall } from './channel-tool-args.js';
import { decideGateAs, type NamedRefusal } from './channel-tool-gate.js';
import {
  holdView,
  inboxView,
  outboxView,
  threadView,
  unansweredView,
  viewOf,
} from './channel-view.js';
import { activeEcosystemIdsOf, isActiveMember } from './membership-store.js';
import { namedRefusals, type SideCodes, sideOf } from './tool-side.js';

const DESCRIPTION = [
  "Act in a project's ecosystem channel under the credential's own role: a viewer reads, a member writes.",
  'Reads: register, inbox, outbox, unanswered (what this side owes a reply to: the work a master takes), read (one document), thread, contracts (a project API page).',
  'Writes: draft, reply (a draft answering a number), edit, submit (publishes, or waits at the approve gate), hold and release a conversation, withdraw, supersede, gate (approve or return a document waiting at the approve gate; an admin decides).',
  'The author is stamped from the credential and never read from the arguments: in chat the person, via assistant; on /mcp an agent token writes via master and a personal one via cli.',
  'Show a person a draft and submit it only once they confirm; hold, withdraw and supersede need a reason.',
  "You read only documents this project sends or receives, never another pair or a counterparty internal; in a chat at ecosystem scope you also read those of the person's other projects in that ecosystem, and you still write only as this project.",
  'A refusal comes back as { code, path, detail }; say what was refused and why.',
].join(' ');

type Answer = Record<string, unknown>;

const refusedWith = (refusals: readonly NamedRefusal[]): Answer => ({
  _mcpIsError: true,
  error: {
    code: refusals.length === 1 ? refusals[0]?.code : 'CHANNEL_REFUSED',
    message: `refused, nothing written: ${refusals.map((r) => `${r.code} at ${r.path}`).join('; ')}`,
    refusals,
  },
});

const one = (code: string, path: string, detail: string): Answer =>
  refusedWith([{ code, path, detail }]);

function settled(outcome: ChannelOutcome): Answer {
  return outcome.ok ? viewOf(outcome.served) : refusedWith(outcome.refusals);
}

const refuseChannel = (code: ChannelRefusalCode, path: string, detail: string) =>
  new RefusalError([{ code, path, detail }], code);

async function soleEcosystem(projectId: string, named: string | undefined): Promise<string> {
  const active = (await activeEcosystemIdsOf(db, [projectId])).map((m) => m.ecosystemId);
  if (named) {
    if (active.includes(named)) return named;
    throw refuseChannel(
      'CHANNEL_NOT_A_PARTY',
      '/ecosystem',
      `project ${projectId} is not active in ecosystem ${named}`,
    );
  }
  if (active.length === 1 && active[0]) return active[0];
  throw refuseChannel(
    'CHANNEL_ECOSYSTEM_AMBIGUOUS',
    '/ecosystem',
    active.length === 0
      ? `project ${projectId} is active in no ecosystem, so it has no channel`
      : `project ${projectId} is active in ${active.length} ecosystems (${active.join(', ')}); name one`,
  );
}

async function documentId(projectId: string, ref: string): Promise<string> {
  return UUID_PATTERN.test(ref) ? ref : (await readAs(projectId, ref)).id;
}

interface ReadScope {
  ecosystemId: string | null;
  sides: readonly string[];
}

type Handlers = {
  [A in ChannelAction]: (
    args: ChannelArgs<A>,
    side: string,
    writer: Writer,
    scope: ReadScope,
  ) => Promise<Answer>;
};

async function scopedEcosystem(side: string, named: string | undefined, scope: ReadScope) {
  if (!scope.ecosystemId) return soleEcosystem(side, named);
  if (named && named !== scope.ecosystemId) {
    throw refuseChannel(
      'CHANNEL_NOT_A_PARTY',
      '/ecosystem',
      `this chat reads at ecosystem ${scope.ecosystemId}'s scope, so ecosystem ${named} is outside it`,
    );
  }
  return scope.ecosystemId;
}

// a widened read is the same party read as a project-scoped one, asked as each side of the fence in turn, home first; a document none of them is a party to stays unreadable
async function firstParty<T>(sides: readonly string[], read: (side: string) => Promise<T>) {
  let last: unknown;
  for (const side of sides) {
    try {
      return await read(side);
    } catch (err) {
      if (!(err instanceof HTTPException && err.status === 404)) throw err;
      last = err;
    }
  }
  throw last;
}

const HANDLERS: Handlers = {
  register: async (a, side, w, scope) => {
    const ecosystem = await scopedEcosystem(side, a.ecosystem, scope);
    const { rows, total } = await readRegister(w.userId, ecosystem, {
      status: a.status,
      type: a.type,
      limit: a.limit,
      fence: scope.sides,
    });
    return { ecosystem, documents: rows, returned: rows.length, total };
  },
  inbox: async (_a, side) => ({ documents: inboxView(await inbox(side)) }),
  unanswered: async (_a, side) => {
    const documents = unansweredView(await unanswered(side));
    return { project: side, documents, returned: documents.length };
  },
  outbox: async (_a, side) => ({ documents: outboxView(await outbox(side)) }),
  read: async (a, _side, _w, scope) => {
    const view = await firstParty(scope.sides, (s) => readAs(s, a.ref));
    return { ...viewOf(view), side: view.side, hold: view.hold };
  },
  thread: async (a, _side, _w, scope) =>
    threadView(await firstParty(scope.sides, (s) => threadAs(s, a.thread))),
  contracts: async (a, side, w, scope) => readApiPage(w.userId, a.project ?? side, scope.sides),
  draft: async ({ ecosystem, ...input }, side, writer, scope) =>
    settled(
      await createDraft({
        projectId: side,
        writer,
        ecosystemId: await scopedEcosystem(side, ecosystem, scope),
        input,
      }),
    ),
  reply: async ({ to, ...input }, side, writer) => {
    const parent = await readAs(side, input.inReplyTo);
    return settled(
      await createDraft({
        projectId: side,
        writer,
        ecosystemId: parent.document.ecosystem,
        input: { ...input, to: to ?? [parent.document.from] },
      }),
    );
  },
  edit: async ({ ref, ...input }, side, writer) =>
    settled(
      await editDraft({ projectId: side, documentId: await documentId(side, ref), writer, input }),
    ),
  submit: async (a, side, writer) =>
    settled(await submit({ projectId: side, documentId: await documentId(side, a.ref), writer })),
  hold: async (a, side, writer) => held(side, a.thread, 'hold', writer, a.reason),
  release: async (a, side, writer) => held(side, a.thread, 'release', writer, a.reason),
  withdraw: async (a, side, writer) =>
    settled(
      await withdraw({
        projectId: side,
        documentId: await documentId(side, a.ref),
        writer,
        reason: a.reason,
      }),
    ),
  supersede: async (a, side, writer) =>
    settled(
      await supersede({
        projectId: side,
        documentId: await documentId(side, a.ref),
        writer,
        by: a.by,
        reason: a.reason,
      }),
    ),
  gate: async (a, side, writer) => {
    const outcome = await decideGateAs({
      side,
      documentId: await documentId(side, a.ref),
      decision: a.decision,
      note: a.note,
      writer,
    });
    return outcome.ok ? outcome.value : refusedWith(outcome.refusals);
  },
};

async function held(
  side: string,
  thread: string,
  action: 'hold' | 'release',
  writer: Writer,
  reason: string | undefined,
): Promise<Answer> {
  const outcome = await holdOrRelease({ sideProjectId: side, thread, action, writer, reason });
  if (!outcome.ok) return refusedWith(outcome.refusals);
  return holdView(thread, outcome);
}

const isWrite = (action: ChannelAction) => (CHANNEL_WRITES as readonly string[]).includes(action);

const OWN_AUTHORITY: readonly ChannelAction[] = ['hold', 'release', 'gate'];

// a hold and a gate are read-gated here as on REST: who may act is the hold rule's HOLD_NOT_AUTHORISED and the gate option's PERMISSION_FORBIDDEN, so both doors refuse a viewer with the same code
const roleNeeded = (action: ChannelAction) =>
  isWrite(action) && !OWN_AUTHORITY.includes(action) ? 'write' : 'read';

const PATH_OF: Partial<Record<ChannelAction, string>> = {
  read: '/ref',
  edit: '/ref',
  submit: '/ref',
  withdraw: '/ref',
  supersede: '/ref',
  gate: '/ref',
  thread: '/thread',
  reply: '/inReplyTo',
  contracts: '/project',
};

const SIDE_CODES: SideCodes = {
  invalid: 'CHANNEL_ARGUMENT_INVALID',
  unbound: 'CHANNEL_TURN_UNBOUND',
  unnamed: 'CHANNEL_PROJECT_UNNAMED',
  outside: 'CHANNEL_PROJECT_OUTSIDE_TOKEN',
};

async function run(ctx: McpContext, raw: Record<string, unknown>): Promise<Answer> {
  const { projectId: named, ...rest } = raw;
  const resolved = await sideOf(ctx, named, SIDE_CODES);
  if (!resolved.ok) return refusedWith([resolved.refusal]);
  const { side } = resolved;
  const call = parseChannelCall(rest);
  if (!call.ok) return refusedWith(call.refusals);
  const { principal } = ctx;
  const role = await channelRoleRefusal(principal.userId, side, roleNeeded(call.action));
  if (role) return refusedWith([role]);
  if (isWrite(call.action) && !principal.scopes.includes('write')) {
    return one(
      'CHANNEL_WRITE_NOT_AUTHORISED',
      '/action',
      `${call.action} writes, and the token this call runs under lacks the 'write' scope`,
    );
  }
  const writer = await writerOfPrincipal(principal);
  const handler = HANDLERS[call.action] as (
    a: Record<string, unknown>,
    s: string,
    w: Writer,
    r: ReadScope,
  ) => Promise<Answer>;
  const ecosystemId = ctx.turn?.ecosystemId ?? null;
  if (ecosystemId && !(await isActiveMember(db, side, ecosystemId))) {
    return one(
      'ECOSYSTEM_NOT_MEMBER',
      '/',
      `this chat reads at ecosystem ${ecosystemId}'s scope from project ${side}, which is no longer an active member of it, so it reads and writes nothing there`,
    );
  }
  const scope: ReadScope = {
    ecosystemId,
    sides: ecosystemId ? await ecosystemReadFence(principal.userId, side, ecosystemId) : [side],
  };
  try {
    return await handler(call.args, side, writer, scope);
  } catch (err) {
    const decided = namedRefusals(err);
    if (decided) return refusedWith(decided);
    if (err instanceof HTTPException && (err.status === 404 || err.status === 403)) {
      return one('CHANNEL_NOT_A_PARTY', PATH_OF[call.action] ?? '/', err.message);
    }
    throw err;
  }
}

const grantOf = (action: ChannelAction) => (isWrite(action) ? 'projects:write' : 'projects:read');

// every action takes the permission its REST route takes; the register is read fenced to this side, the same rows its inbox and outbox hold, so it is a project read and not the account-wide ecosystems:read
export const forgeChannelTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_channel',
  description: DESCRIPTION,
  inputSchema: CHANNEL_INPUT_SCHEMA,
  route: '/api/projects',
  grant: {
    byAction: Object.fromEntries(CHANNEL_ACTIONS.map((a) => [a, grantOf(a)])) as Record<
      ChannelAction,
      'projects:read' | 'projects:write'
    >,
  },
  reach: {
    byAction: Object.fromEntries(CHANNEL_ACTIONS.map((a) => [a, 'project'])) as Record<
      ChannelAction,
      'project'
    >,
  },
  handler: (raw) => run(ctx, raw),
});
