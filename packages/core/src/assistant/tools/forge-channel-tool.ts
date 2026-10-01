import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import { readApiPage } from '../../ecosystem/api-page.js';
import type { ChannelOutcome } from '../../ecosystem/channel-act.js';
import {
  channelRoleRefusal,
  type Writer,
  writerOfPrincipal,
} from '../../ecosystem/channel-author.js';
import { supersede, withdraw } from '../../ecosystem/channel-ends.js';
import { holdOrRelease } from '../../ecosystem/channel-holds.js';
import { inbox, outbox, readAs, threadAs } from '../../ecosystem/channel-read.js';
import { readRegister } from '../../ecosystem/channel-register.js';
import { createDraft, editDraft, submit } from '../../ecosystem/channel-service.js';
import { viewOf } from '../../ecosystem/channel-view.js';
import { activeEcosystemIdsOf } from '../../ecosystem/store.js';
import type { ContextScopedMcpToolFactory, McpContext } from '../../mcp/tools/lib.js';
import {
  CHANNEL_ACTIONS,
  CHANNEL_INPUT_SCHEMA,
  CHANNEL_WRITES,
  type ChannelAction,
  type ChannelArgs,
  parseChannelCall,
} from './forge-channel-args.js';
import { decideGateAs, type NamedRefusal } from './forge-channel-gate.js';

const DESCRIPTION = [
  "Act in this project's ecosystem channel as the person you are answering, under their own role: a viewer reads, a member writes.",
  'Reads: register, inbox, outbox, read (one document), thread, contracts (a project API page).',
  'Writes: draft, reply (a draft answering a number), edit, submit (publishes, or waits at the approve gate), hold and release a conversation, withdraw, supersede, gate (approve or return a document waiting at the approve gate; an admin decides).',
  'Every document you write is authored by the person, via assistant.',
  'Show the person a draft and submit it only once they confirm; hold, withdraw and supersede need their reason.',
  'You read only documents this project sends or receives, never another pair or a counterparty internal.',
  'A refusal comes back as { code, path, detail }; tell them what was refused and why.',
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function settled(outcome: ChannelOutcome): Answer {
  return outcome.ok ? viewOf(outcome.served) : refusedWith(outcome.refusals);
}

class Unreadable extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(detail);
  }
}

class Ambiguous extends Error {}

async function soleEcosystem(projectId: string, named: string | undefined): Promise<string> {
  const active = (await activeEcosystemIdsOf(db, [projectId])).map((m) => m.ecosystemId);
  if (named) {
    if (active.includes(named)) return named;
    throw new Unreadable('/ecosystem', `project ${projectId} is not active in ecosystem ${named}`);
  }
  if (active.length === 1 && active[0]) return active[0];
  throw new Ambiguous(
    active.length === 0
      ? `project ${projectId} is active in no ecosystem, so it has no channel`
      : `project ${projectId} is active in ${active.length} ecosystems (${active.join(', ')}); name one`,
  );
}

async function documentId(projectId: string, ref: string): Promise<string> {
  return UUID.test(ref) ? ref : (await readAs(projectId, ref)).id;
}

type Handlers = {
  [A in ChannelAction]: (args: ChannelArgs<A>, side: string, writer: Writer) => Promise<Answer>;
};

const HANDLERS: Handlers = {
  register: async (a, side, w) => {
    const ecosystem = await soleEcosystem(side, a.ecosystem);
    const { rows, total } = await readRegister(w.userId, ecosystem, {
      status: a.status,
      type: a.type,
      limit: a.limit,
      fence: [side],
    });
    return { ecosystem, documents: rows, returned: rows.length, total };
  },
  inbox: async (_a, side) => {
    const entries = await inbox(side);
    return {
      documents: entries.map((e) => ({
        ...viewOf(e),
        hold: e.hold,
        owesReply: e.owesReply,
        answered: e.answered,
        overdue: e.overdue,
      })),
    };
  },
  outbox: async (_a, side) => ({
    documents: (await outbox(side)).map((v) => ({ ...viewOf(v), hold: v.hold })),
  }),
  read: async (a, side) => {
    const view = await readAs(side, a.ref);
    return { ...viewOf(view), side: view.side, hold: view.hold };
  },
  thread: async (a, side) => {
    const t = await threadAs(side, a.thread);
    return {
      thread: t.thread,
      documents: t.documents.map((v) => ({ ...viewOf(v), side: v.side })),
      holds: t.holds,
    };
  },
  contracts: async (a, side, w) => readApiPage(w.userId, a.project ?? side, [side]),
  draft: async ({ ecosystem, ...input }, side, writer) =>
    settled(
      await createDraft({
        projectId: side,
        writer,
        ecosystemId: await soleEcosystem(side, ecosystem),
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
  return { thread, held: outcome.held, hold: outcome.hold };
}

const isWrite = (action: ChannelAction) => (CHANNEL_WRITES as readonly string[]).includes(action);

const OWN_AUTHORITY: readonly ChannelAction[] = ['hold', 'release', 'gate'];

// cm:why a hold and a gate are read-gated here as on REST: who may act is the hold rule's HOLD_NOT_AUTHORISED and the gate option's QUESTION_AUTHORITY_REQUIRED, so both doors refuse a viewer with the same code
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

async function run(ctx: McpContext, raw: Record<string, unknown>): Promise<Answer> {
  const side = ctx.boundProjectId ?? null;
  if (!side) {
    return one(
      'CHANNEL_TURN_UNBOUND',
      '/',
      'this turn answers under no project, so there is no side of a channel to act for',
    );
  }
  const call = parseChannelCall(raw);
  if (!call.ok) return refusedWith(call.refusals);
  const { principal } = ctx;
  const role = await channelRoleRefusal(principal.userId, side, roleNeeded(call.action));
  if (role) return refusedWith([role]);
  if (isWrite(call.action) && !principal.scopes.includes('write')) {
    return one(
      'CHANNEL_WRITE_NOT_AUTHORISED',
      '/action',
      `${call.action} writes, and the token this turn runs under lacks the 'write' scope the person's own credential did not grant`,
    );
  }
  const writer = await writerOfPrincipal(principal);
  const handler = HANDLERS[call.action] as (
    a: Record<string, unknown>,
    s: string,
    w: Writer,
  ) => Promise<Answer>;
  try {
    return await handler(call.args, side, writer);
  } catch (err) {
    if (err instanceof Unreadable) return one('CHANNEL_NOT_A_PARTY', err.path, err.message);
    if (err instanceof Ambiguous)
      return one('CHANNEL_ECOSYSTEM_AMBIGUOUS', '/ecosystem', err.message);
    if (err instanceof HTTPException && (err.status === 404 || err.status === 403)) {
      return one('CHANNEL_NOT_A_PARTY', PATH_OF[call.action] ?? '/', err.message);
    }
    throw err;
  }
}

const grantOf = (action: ChannelAction) => (isWrite(action) ? 'projects:write' : 'projects:read');

// cm:why every action takes the permission its REST route takes; the register is read fenced to this side, the same rows its inbox and outbox hold, so it is a project read and not the account-wide ecosystems:read
export const forgeChannelTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_channel',
  description: DESCRIPTION,
  inputSchema: CHANNEL_INPUT_SCHEMA,
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
