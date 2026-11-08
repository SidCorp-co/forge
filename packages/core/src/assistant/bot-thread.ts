// A persistent project thread with the Forge bot, as an MCP client follows it (REQ-91). The thread IS
// a web room: opened, written and answered by the machinery the Forge UI's chat uses (`service.ts`,
// `conversation-send.ts`, `route-window.ts`), so the bot is the one the UI talks to, its memory is
// the room's transcript, and the UI and `GET /api/conversations/:id` read the same thread. What is
// added here is only what a client that cannot hold a socket needs: a turn followed by the message
// that started it, its state read off the window that answers it, and a wait bounded by the call.

import type { UiPageItem } from '@forge/contracts/ui-actions';
import {
  awaitingReplies,
  type ConversationRow,
  type ConversationWindowRow,
  derivedScope,
  effectiveConversationMode,
  messageInRoom,
  readableConversation,
  readConversationAgentTurns,
  readMessages,
  readMessagesInRange,
  refuseConversation,
  toolContentFor,
  windowCovering,
} from '../conversations/index.js';
import { rememberUiSnapshot } from './ui-snapshot.js';

/** The states a turn is read in (REQ-91 BC-4). */
export type BotTurnState = 'queued' | 'running' | 'completed' | 'failed' | 'needs-input';

export interface BotTurn {
  /** The id of the message that started the turn: the handle a later read follows it by. */
  id: string;
  seq: number;
  state: BotTurnState;
  /** On `failed`: what the window recorded, in its own words. */
  reason: string | null;
}

export interface BotMessage {
  id: string;
  seq: number;
  role: string;
  author: string | null;
  content: string;
  /** This reply asks the person something, and the turn waits on their answer (ISS-277). */
  awaitsReply: boolean;
  /** Why the bot chose to say nothing here, where it chose to. */
  silence: string | null;
  createdAt: string;
}

const LAST_SEQ = 2_147_483_647;

/**
 * The room a caller reaches as a thread of this project: readable by them, a web room, and about
 * exactly this project. A room about another project is refused by name, never answered as this one.
 */
export async function threadIn(
  projectId: string,
  thread: string,
  userId: string,
): Promise<ConversationRow> {
  const room = await readableConversation(thread, userId);
  const scope = await derivedScope(room.id);
  if (room.adapter !== 'web' || scope.length !== 1 || scope[0] !== projectId) {
    throw refuseConversation(
      'BOT_THREAD_NOT_IN_PROJECT',
      `thread ${thread} is no Forge bot thread of project ${projectId} (it is a ${room.adapter} room about ${scope.join(', ') || 'no project'}), so nothing was read or written in it — open one in this project with bot.open { projectId }`,
      '/thread',
    );
  }
  return room;
}

/** The record a thread's next turns are about, as the UI's page beside the chat names it (REQ-30 BC-6). */
export function rememberAbout(conversationId: string, about: UiPageItem): void {
  rememberUiSnapshot(conversationId, { v: 1, route: about.kind, path: '', item: about });
}

/** A failed window's own reason: what its detail recorded, else its decision. */
function reasonOf(window: ConversationWindowRow, decision: string): string {
  const detail = (window.decisionDetail ?? {}) as Record<string, unknown>;
  const continued = (detail.continued ?? {}) as Record<string, unknown>;
  for (const v of [continued.reason, continued.error, detail.reason, detail.code, detail.error]) {
    if (typeof v === 'string' && v.length > 0) return `${decision}: ${v}`;
  }
  return decision;
}

const FAILED = new Set([
  'authority-refused',
  'unreachable',
  'undetermined',
  'guard-backoff',
  'guard-agent-loop',
  'guard-dormant',
  'stopped',
]);

/**
 * The state of the turn the message at `seq` started, read off the window that answers it and the
 * replies after it. Nothing is guessed: a window still open is queued or running, a closed one says
 * what it decided, and a reply that awaits the person's answer is needs-input.
 */
export async function turnOf(
  room: ConversationRow,
  message: { id: string; seq: number },
  viewerId: string,
): Promise<BotTurn> {
  const turn = (state: BotTurnState, reason: string | null = null): BotTurn => ({
    id: message.id,
    seq: message.seq,
    state,
    reason,
  });
  const window = await windowCovering(room.id, message.seq);
  if (!window?.claimedAt) return turn('queued');
  if (!window.closedAt || !window.decision) return turn('running');
  const detail = (window.decisionDetail ?? {}) as Record<string, unknown>;
  if (detail.continuing === true) return turn('running');
  const continued = detail.continued as { decision?: unknown } | undefined;
  const decision =
    typeof continued?.decision === 'string' ? continued.decision : (window.decision as string);

  if (decision === 'handed-off') {
    const agent = (await readConversationAgentTurns(room.id, viewerId)).find(
      (t) => t.windowId === window.id,
    );
    if (!agent || agent.state === 'dispatched') return turn('queued');
    if (agent.state === 'running') return turn('running');
    if (agent.state === 'failed') return turn('failed', `agent: ${agent.reason ?? 'failed'}`);
    if (agent.state === 'held') return turn('failed', `held: ${agent.held?.reason ?? 'held'}`);
  } else if (FAILED.has(decision)) {
    return turn('failed', reasonOf(window, decision));
  }

  const after = await readMessagesInRange(room.id, {
    firstSeq: message.seq + 1,
    lastSeq: LAST_SEQ,
    limit: 50,
    order: 'oldest-first',
  });
  const last = after.filter((m) => m.role === 'assistant').at(-1);
  if (last && (await awaitingReplies(room.id, [last.id])).has(last.id)) return turn('needs-input');
  return turn('completed');
}

/** The newest message a person sent among the room's latest, the turn a read with no handle follows. */
export async function latestAsked(
  room: ConversationRow,
): Promise<{ id: string; seq: number } | null> {
  const last = (await readMessages(room.id, 200)).filter((m) => m.role === 'user').at(-1);
  return last ? { id: last.id, seq: last.seq } : null;
}

/** The message a turn handle names, or the refusal saying it names none in this thread. */
export async function askedBy(room: ConversationRow, turnId: string) {
  const message = await messageInRoom(room.id, turnId);
  if (message?.role !== 'user') {
    throw refuseConversation(
      'BOT_TURN_UNKNOWN',
      `turn ${turnId} names no message sent in thread ${room.id}; a turn is followed by the id bot.send answered as turn.id`,
      '/turn',
    );
  }
  return message;
}

/** The messages after `after`, oldest first, as `viewerId` may read them. */
export async function messagesAfter(
  room: ConversationRow,
  after: number,
  limit: number,
  viewerId: string,
  /** Which end `limit` keeps: the ones right after the cursor, or the room's newest. */
  end: 'oldest' | 'newest' = 'oldest',
): Promise<BotMessage[]> {
  const rows = await readMessagesInRange(room.id, {
    firstSeq: after + 1,
    lastSeq: LAST_SEQ,
    limit,
    order: end === 'oldest' ? 'oldest-first' : 'newest-first',
  });
  const awaiting = await awaitingReplies(
    room.id,
    rows.filter((r) => r.role === 'assistant').map((r) => r.id),
  );
  return rows.map((raw) => {
    const m = toolContentFor(raw, viewerId);
    return {
      id: m.id,
      seq: m.seq,
      role: m.role,
      author: m.authorLabel,
      content: m.content,
      awaitsReply: awaiting.has(m.id),
      silence: m.silenceReason,
      createdAt: m.createdAt.toISOString(),
    };
  });
}

/** What a thread is, as an answer names it: where else it is read included (REQ-91 BC-7). */
export function threadShown(room: ConversationRow) {
  return {
    thread: room.id,
    title: room.title,
    mode: effectiveConversationMode(room),
    readElsewhere: `the project's chat in the Forge UI, and GET /api/conversations/${room.id}`,
  };
}

export const isSettled = (state: BotTurnState) => state !== 'queued' && state !== 'running';
