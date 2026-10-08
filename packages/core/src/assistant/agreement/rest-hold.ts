// The REST side of BC-4 (REQ-30): a record route's write that arrives on a chat credential is held
// (`middleware/chat-write-hold.ts`). Read from the credential the request arrived on, so an Agent
// session's shell meets it whatever command it writes with:
// - an Agent-mode session answering a room: the request is kept, bytes and all, as a proposal the
//   person sees as a confirm card, and refused CHAT_WRITE_AWAITS_AGREEMENT;
// - the assistant's own turn token: its writes are held by its toolset (`turn-gate.ts`), so one
//   that reaches a record route went around it and is refused outright;
// - the token an agreed proposal is written under: let through while that proposal is being
//   written, and refused once it is settled;
// - a box session answering no room (the Agents screen, a room escalation) is not held: no room
//   shows it a card, and the person drives that session directly.
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
import { actorFor, projectResource, requireCan } from '../../permissions/index.js';
import { readProposal, recordProposal } from './store.js';
import { summaryOfRest } from './summary.js';

const refuse = refuser<ChatProposalRefusalCode>('CHAT_WRITE_AWAITS_AGREEMENT');

/** Every record route a chat's write is held on needs project.write where it lands. */
const RECORD_PERMISSION = 'project.write';

async function requireRole(c: Context, projectId: string): Promise<void> {
  await requireCan(actorFor(c.get('userId')), RECORD_PERMISSION, projectResource(projectId));
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
  const read = await agentTurnOfSession(sessionId);
  if (!read.found) {
    throw refuse(
      'CHAT_WRITE_AWAITS_AGREEMENT',
      `this credential belongs to chat session ${sessionId}, which is gone, so nobody can agree to this write; nothing was written`,
    );
  }
  if (!read.turn) {
    if (!read.marked) return;
    throw refuse(
      'CHAT_WRITE_AWAITS_AGREEMENT',
      `chat session ${sessionId} is marked as answering a room, but which room and whom cannot be read from it, so nobody can agree to this write; nothing was written`,
    );
  }
  const { turn } = read;
  await requireRole(c, turn.projectId);
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
    summary: summaryOfRest(
      kind,
      path,
      await jsonOf(bytes, contentType),
      await fileNameOf(bytes, contentType),
    ),
  });
  throw refuse(
    'CHAT_WRITE_AWAITS_AGREEMENT',
    `nothing was written. Core holds this ${kind} as proposal ${row.id} until the person agrees; they see it in the conversation as a confirm card they can record or decline. End your reply by restating what it records and what it relates to and asking for their go-ahead; do not say it is recorded. When they agree in their next message, POST /api/conversations/${turn.conversationId}/proposals/${row.id}/agree with { "words": <their whole message>, "kind": "${kind}" }: core writes this exact request as them. Do not send it again.`,
  );
}

/** The hold every record route runs before its handler (`provideChatWriteHold`). */
export async function holdChatRestWrite(c: Context, kind: ChatProposalKind): Promise<void> {
  const scope = currentPatScope();
  if (!scope) return;
  const door = await chatDoorOfToken(scope.tokenId);
  if (!door) return;
  switch (door.door) {
    case 'agreement': {
      const row = await readProposal(door.proposalId);
      if (row?.status === 'agreed') return;
      throw refuse(
        'CHAT_AGREEMENT_SPENT',
        `this credential writes proposal ${door.proposalId} alone, while it is being written, and it is ${row?.status ?? 'gone'}; nothing was written`,
      );
    }
    case 'assistant-turn':
      for (const projectId of scope.projectIds ?? []) await requireRole(c, projectId);
      throw refuse(
        'CHAT_WRITE_AWAITS_AGREEMENT',
        "this is the assistant's turn token, and a chat's write waits for the person to agree: it is held through the turn's own tools (forge_feedback, the requirement tools, forge comment and forge attach), which show the person a confirm card. Nothing was written.",
      );
    case 'box-session':
      for (const projectId of scope.projectIds ?? []) await requireRole(c, projectId);
      return holdSessionWrite(c, kind, door.sessionId);
  }
}
