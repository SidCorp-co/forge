// The REST and /mcp side of BC-4 (REQ-30). Every write a chat credential sends is held, passed or
// refused by the one chat write rule (`write-rule.ts`), read from the credential the request arrived
// on, so an Agent session's shell meets it whatever command it writes with:
// - a route whose own hold names its kind (`middleware/chat-write-hold.ts:holdChatWrite`) is held:
//   - an Agent-mode session answering a room: the request is kept, bytes and all, as a proposal the
//     person sees as a confirm card, and refused CHAT_WRITE_AWAITS_AGREEMENT;
//   - the assistant's own turn token: its writes are held by its toolset (`turn-gate.ts`), so one
//     that reaches a record route went around it and is refused outright;
//   - the token an agreed proposal is written under: let through while that proposal is being
//     written, and refused once it is settled;
// - any other write is passed where the rule names it as not a business write, and otherwise refused
//   CHAT_WRITE_REFUSED by name (`admitChatRestWrite`), as is a write tool called over /mcp
//   (`refuseChatToolWrite`): no card carries it, so a route added later is refused, never let through;
// - a box session answering no room (the Agents screen, a Rocket.Chat escalation) is not held or
//   refused: no room shows it a card, and it writes as before (ruled 2026-10-09, ISS-439). Which
//   sessions those are is read from where each was started, never from metadata it can edit
//   (`conversations/conversation-agent-stage.ts:agentTurnOfSession`), so a session cannot make
//   itself one.
// A write the person's own role could not make is refused for that first, by the permission it
// lacks, as the route itself would: a card offering it would only fail when pressed.

import {
  CHAT_PROPOSAL_BODY_MAX_BYTES,
  type ChatProposalKind,
  type ChatProposalRefusalCode,
} from '@forge/contracts/chat-proposals';
import type { Context } from 'hono';
import { chatDoorOfToken } from '../../agent-sessions/index.js';
import { agentTurnOfSession } from '../../conversations/index.js';
import { currentPatScope } from '../../credentials/pat-scope.js';
import { refuser } from '../../lib/refusal.js';
import type { ToolGrantEntry } from '../../lib/tool.js';
import type { ChatWriteRoute } from '../../middleware/chat-write-hold.js';
import { namedRefs } from './named-refs.js';
import { requireRoleFor } from './roles.js';
import { readProposal, recordProposal } from './store.js';
import { summaryOfRest } from './summary.js';
import { decideRestWrite, decideToolCall, refusedWriteText } from './write-rule.js';

const refuse = refuser<ChatProposalRefusalCode>('CHAT_WRITE_AWAITS_AGREEMENT');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The person's role must make the write where it lands, as the route itself would ask. */
function requireRole(c: Context, kind: ChatProposalKind, projectId: string): Promise<void> {
  return requireRoleFor(kind, c.get('userId'), projectId);
}

/** The request headers a record route reads beside the body, kept so the agreed write reads the same. */
const KEPT_HEADERS = ['x-forge-capabilities'] as const;

function keptHeaders(c: Context): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = c.req.header(name);
    if (value) kept[name] = value;
  }
  return kept;
}

async function jsonOf(bytes: Buffer, contentType: string | null) {
  if (!contentType?.includes('json')) return {};
  try {
    const v = JSON.parse(bytes.toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function fileNameOf(bytes: Buffer, contentType: string | null): Promise<string | null> {
  if (!contentType?.startsWith('multipart/form-data')) return null;
  try {
    const form = await new Response(new Uint8Array(bytes), {
      headers: { 'content-type': contentType },
    }).formData();
    const file = form.get('file');
    return file instanceof File ? file.name || null : null;
  } catch {
    return null;
  }
}

async function holdSessionWrite(c: Context, kind: ChatProposalKind, sessionId: string) {
  // a turn token whose session id is no uuid names no row: read as gone, never sent to the database
  const read = UUID_RE.test(sessionId)
    ? await agentTurnOfSession(sessionId)
    : ({ found: false } as const);
  if (!read.found) {
    throw refuse(
      'CHAT_WRITE_AWAITS_AGREEMENT',
      `this credential belongs to chat session ${sessionId}, which is gone, so nobody can agree to this write; nothing was written`,
    );
  }
  if (!read.answersRoom) return;
  if (!read.turn) {
    throw refuse(
      'CHAT_WRITE_AWAITS_AGREEMENT',
      `chat session ${sessionId} was started to answer a room, but which room and whom cannot be read from it, so nobody can agree to this write; nothing was written`,
    );
  }
  const { turn } = read;
  await requireRole(c, kind, turn.projectId);
  if (!turn.asker) {
    throw refuse(
      'CHAT_WRITE_AWAITS_AGREEMENT',
      'this session answers a room turn that names nobody it asks for, so nobody can agree to this write; nothing was written',
    );
  }
  const bytes = Buffer.from(await c.req.arrayBuffer());
  if (bytes.length > CHAT_PROPOSAL_BODY_MAX_BYTES) {
    throw refuse(
      'CHAT_PROPOSAL_TOO_LARGE',
      `this request carries ${bytes.length} bytes, and a write held for the person's agreement carries at most ${CHAT_PROPOSAL_BODY_MAX_BYTES}; nothing was written`,
    );
  }
  const contentType = c.req.header('content-type') ?? null;
  const url = new URL(c.req.url);
  const path = `${url.pathname}${url.search}`;
  const row = await recordProposal({
    projectId: turn.projectId,
    conversationId: turn.conversationId,
    proposedTo: turn.asker.userId,
    handleUserId: null,
    sessionId,
    kind,
    form: 'rest',
    call: { method: c.req.method, path, contentType, headers: keptHeaders(c) },
    body: bytes.length > 0 ? bytes : null,
    summary: await namedRefs(
      turn.projectId,
      summaryOfRest({
        kind,
        method: c.req.method,
        path,
        body: await jsonOf(bytes, contentType),
        attachmentName: await fileNameOf(bytes, contentType),
      }),
    ),
  });
  throw refuse(
    'CHAT_WRITE_AWAITS_AGREEMENT',
    `nothing was written. Core holds this ${kind} as proposal ${row.id} until the person agrees; they see it in the conversation as a confirm card with Record it and Decline. End your reply by restating what it records and what it relates to and asking them to press Record it on the card; do not say it is recorded. Only their press writes it: a reply they type, yes or no, writes nothing, and nothing you send agrees for them. Do not send this request again unless they want it changed.`,
  );
}

/** An agreement token writes its one proposal while it is being written, and is refused after. */
async function agreedProposalWrites(proposalId: string): Promise<void> {
  const row = await readProposal(proposalId);
  if (row?.status === 'agreed') return;
  throw refuse(
    'CHAT_AGREEMENT_SPENT',
    `this credential writes proposal ${proposalId} alone, while it is being written, and it is ${row?.status ?? 'gone'}; nothing was written`,
  );
}

/** The hold every record route runs before its handler (`provideChatWriteHold`). */
export async function holdChatRestWrite(c: Context, kind: ChatProposalKind): Promise<void> {
  const scope = currentPatScope();
  if (!scope) return;
  const door = await chatDoorOfToken(scope.tokenId);
  if (!door) return;
  switch (door.door) {
    case 'agreement':
      return agreedProposalWrites(door.proposalId);
    case 'assistant-turn':
      for (const projectId of scope.projectIds ?? []) await requireRole(c, kind, projectId);
      throw refuse(
        'CHAT_WRITE_AWAITS_AGREEMENT',
        "this is the assistant's turn token, and a chat's write waits for the person to agree: it is held through the turn's own tools (forge_feedback, the requirement tools, forge comment, forge attach, forge issue and forge project), which show the person a confirm card. Nothing was written.",
      );
    case 'box-session':
      for (const projectId of scope.projectIds ?? []) await requireRole(c, kind, projectId);
      return holdSessionWrite(c, kind, door.sessionId);
  }
}

/**
 * A box session started where no room answers (the Agents screen, a Rocket.Chat escalation), which
 * writes as before (ruled 2026-10-09, ISS-439): read from the run it was opened under, so a session
 * that clears its own room marker is still the room's.
 */
async function answersNoRoom(sessionId: string): Promise<boolean> {
  // a turn token naming no session row (its id is not one) answers for no session at all
  if (!UUID_RE.test(sessionId)) return false;
  const read = await agentTurnOfSession(sessionId);
  return read.found && !read.answersRoom;
}

const refuseWrite = refuser<ChatProposalRefusalCode>('CHAT_WRITE_REFUSED');

/**
 * The default every write request a PAT is admitted on meets (`provideChatWriteHold`): a chat
 * credential's write that no route hold names is passed where the rule names it as not a business
 * write, and otherwise refused CHAT_WRITE_REFUSED by name. A held route is left to its own hold,
 * which runs after the route's validators.
 */
export async function admitChatRestWrite(_c: Context, route: ChatWriteRoute): Promise<void> {
  const scope = currentPatScope();
  if (!scope) return;
  const verdict = decideRestWrite(route);
  if (verdict.verdict !== 'refuse') return;
  const door = await chatDoorOfToken(scope.tokenId);
  if (!door) return;
  // the person pressed Record it on exactly this call: its token writes what the call sends (a CLI
  // call's requests included) while the proposal is being written, and nothing after
  if (door.door === 'agreement') return agreedProposalWrites(door.proposalId);
  if (door.door === 'box-session' && (await answersNoRoom(door.sessionId))) return;
  throw refuseWrite(
    'CHAT_WRITE_REFUSED',
    refusedWriteText(verdict, `${route.method} ${route.route}`),
  );
}

/**
 * The /mcp half: a tool call a chat credential makes is a read, a call the rule passes, or refused
 * by name. Nothing is held here, since a held call is written again through its REST twin, so a
 * write a hold would name is refused pointing at that route. Null lets the call run.
 */
export async function refuseChatToolWrite(
  name: string,
  args: Record<string, unknown>,
  grant: ToolGrantEntry | null,
): Promise<string | null> {
  const scope = currentPatScope();
  if (!scope) return null;
  const verdict = decideToolCall(name, JSON.stringify(args), grant);
  if (verdict.verdict !== 'hold' && verdict.verdict !== 'refuse') return null;
  const door = await chatDoorOfToken(scope.tokenId);
  if (!door) return null;
  if (door.door === 'agreement') {
    const row = await readProposal(door.proposalId);
    if (row?.status === 'agreed') return null;
  }
  if (door.door === 'box-session' && (await answersNoRoom(door.sessionId))) return null;
  if (verdict.verdict === 'hold') {
    return `CHAT_WRITE_REFUSED: ${name} writes a ${verdict.kind}, and a chat's write over /mcp has no card to wait on. Send it to its REST route with forge-runner api, where core holds it for the person's press on a confirm card; nothing was written.`;
  }
  return `CHAT_WRITE_REFUSED: ${refusedWriteText(verdict, name)}`;
}
