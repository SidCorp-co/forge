// Handing a support group's messages to its session (REQ-75 BC-11, BC-16). The session is a `chat`
// row the existing chat-turn path drives on a paired box of the project, and the box keeps its
// Claude Code process resident between turns (`keepResident`), so a turn is written into a warm
// process rather than a fresh spawn. A message goes to the session the moment it is recorded: as a
// turn of its own when none runs, or written into the running turn (`inject.ts`), which Claude Code
// takes at its next tool call or answers straight after it. The drain timer only recovers what a
// crash left undelivered. A turn that ends without completing tells each thread it left unanswered
// so, and those messages are not handed to a turn again.

import type { SupportDeliveryPath, SupportTool } from '@forge/contracts/support';
import {
  dispatchChatTurn,
  mintFencedSessionCredential,
  sessionRowById,
  turnCredentialChatDevice,
} from '../agent-sessions/index.js';
import type { agentSessions } from '../db/schema.js';
import { findBindingWithConnectionById, forgeReads } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import { activeSupportApi } from '../integrations/support-api/index.js';
import { logger } from '../lib/logger.js';
import {
  claimUndelivered,
  markDelivery,
  oldestUndelivered,
  roomsWithUndelivered,
  toldFailed,
  unansweredOfLastTurn,
  unclaim,
} from './delivery.js';
import { injectWaiting, settleInjects } from './inject.js';
import { coldThreads, supportBrief, turnMessages } from './prompt.js';
import { ensureSupportRoom } from './rooms.js';
import { insertAction, offlineToldSince, type RoomRow, roomById } from './store.js';
import { postInThread } from './thread.js';

/** The one grant a support session's token carries: the project's routes, which it may not read. */
const SUPPORT_SESSION_GRANT = ['projects:write'] as const;

/** How long a room whose dispatch failed waits before the drain tries it again. */
const RETRY_AFTER_MS = 30_000;
/** How often a room is told its assistant is offline, at most. */
const OFFLINE_NOTICE_EVERY_MS = 10 * 60_000;

const lastFailure = new Map<string, number>();

/**
 * When each room last handed its session a turn. Read when that turn ends, to tell only the threads
 * it took (and those written into it); core restarting in between leaves it unknown, and the newest
 * hand-over is read instead.
 */
const lastTurn = new Map<string, Date>();
export function noteTurn(roomId: string, at: Date): void {
  lastTurn.set(roomId, at);
}

/**
 * The tools each room's session was last told of. A session briefed once and kept warm is told
 * again when the project's grants change (`warm.ts:retellTools`); core restarting forgets, and the
 * next grant change tells it again.
 */
const briefedTools = new Map<string, string>();
export const toolsKey = (tools: readonly SupportTool[]) =>
  JSON.stringify(tools.map((t) => [t.name, t.kind, t.summary]));
export function toldTools(roomId: string): string | undefined {
  return briefedTools.get(roomId);
}
export function noteTools(roomId: string, tools: readonly SupportTool[]): void {
  briefedTools.set(roomId, toolsKey(tools));
}

export type SessionRow = typeof agentSessions.$inferSelect;
export type TurnClient = Awaited<ReturnType<typeof turnCredentialChatDevice>>;

export async function sessionOf(room: RoomRow): Promise<SessionRow | null> {
  return room.sessionId ? sessionRowById(room.sessionId) : null;
}

/** The room as it stands, its session declared if its binding still names it a support group. */
export async function roomWithSession(roomId: string): Promise<RoomRow | null> {
  const room = await roomById(roomId);
  if (!room || room.sessionId) return room;
  const pair = await findBindingWithConnectionById(room.bindingId);
  const config = (pair?.binding.config ?? null) as RocketChatBindingConfig | null;
  if (!config?.support) return room;
  return ensureSupportRoom({
    projectId: room.projectId,
    bindingId: room.bindingId,
    connectionId: room.connectionId,
    rid: room.rid,
    support: config.support,
  });
}

/** The room's binding config, for the brief's product line. */
async function roomProduct(room: RoomRow): Promise<string | null> {
  const pair = await findBindingWithConnectionById(room.bindingId);
  return (
    ((pair?.binding.config ?? null) as RocketChatBindingConfig | null)?.support?.product ?? null
  );
}

/** Whether a turn of this session starts Claude Code cold (no session of its own to resume). */
export const startsCold = (session: SessionRow, client: TurnClient) =>
  !session.claudeSessionId || Boolean(client.migrated);

/**
 * Hand `body` to the session as one turn, under a token fenced to the project and revoked when the
 * turn ends. A cold turn is briefed first and re-reads its threads. Throws when the turn does not
 * reach its box.
 */
export async function handTurn(
  room: RoomRow,
  session: SessionRow,
  client: TurnClient & { deviceId: string },
  body: { messages: string } | { warmUp: string },
): Promise<void> {
  const [project] = await forgeReads().projectsByIds([room.projectId]);
  if (!project) throw new Error(`support: room ${room.id}'s project ${room.projectId} is gone`);
  const parts: string[] = [];
  if (startsCold(session, client)) {
    const api = await activeSupportApi(room.projectId);
    noteTools(room.id, api?.tools ?? []);
    parts.push(
      supportBrief({
        projectName: project.name,
        product: await roomProduct(room),
        tools: api?.tools ?? [],
      }),
    );
    const history = await coldThreads(room);
    if (history) parts.push(history);
    if ('messages' in body) parts.push('New messages:');
  }
  parts.push('messages' in body ? body.messages : body.warmUp);
  const credential = await mintFencedSessionCredential({
    sessionId: session.id,
    deviceId: client.deviceId,
    userId: room.principalUserId,
    projectId: room.projectId,
    permissions: SUPPORT_SESSION_GRANT,
  });
  await dispatchChatTurn({
    session,
    project: { id: project.id, slug: project.slug },
    client,
    message: parts.join('\n\n'),
    preBuilt: true,
    credential,
    actor: { type: 'system' },
  });
}

export type DeliverOutcome =
  | 'nothing-waiting'
  | 'turn-running'
  | 'injected'
  | 'backing-off'
  | 'no-box'
  | 'dispatched'
  | 'dispatch-failed';

/**
 * Hand every message waiting in a room to its session at once: written into the running turn when
 * one runs, else as a turn of its own. A turn that could not be handed to a box gives its messages
 * back.
 */
export async function deliverWaiting(roomId: string): Promise<DeliverOutcome> {
  const room = await roomWithSession(roomId);
  if (!room) return 'nothing-waiting';
  const session = await sessionOf(room);
  if (!session) return 'nothing-waiting';
  if (session.status === 'running') return injectWaiting(room, session);
  const failedAt = lastFailure.get(room.id);
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return 'backing-off';

  const client = await turnCredentialChatDevice(session);
  if (!client.deviceId) {
    await tellOffline(room);
    lastFailure.set(room.id, Date.now());
    return 'no-box';
  }

  const at = new Date();
  const rows = await claimUndelivered(room.id, at);
  if (rows.length === 0) return 'nothing-waiting';
  const path: SupportDeliveryPath = startsCold(session, client) ? 'start' : 'send';
  noteTurn(room.id, at);
  try {
    await handTurn(
      room,
      session,
      { ...client, deviceId: client.deviceId },
      {
        messages: turnMessages(rows),
      },
    );
    await markDelivery(
      rows.map((r) => r.id),
      { path },
    );
    lastFailure.delete(room.id);
    return 'dispatched';
  } catch (err) {
    logger.error(
      { err, roomId: room.id, sessionId: session.id },
      'support: the turn did not reach its box',
    );
    await unclaim(
      rows.map((r) => r.id),
      at,
    );
    lastFailure.set(room.id, Date.now());
    return 'dispatch-failed';
  }
}

/** Tell the room once in a while that its assistant has no box to run on; the messages wait. */
async function tellOffline(room: RoomRow): Promise<void> {
  if (await offlineToldSince(room.id, new Date(Date.now() - OFFLINE_NOTICE_EVERY_MS))) return;
  const waiting = await oldestUndelivered(room.id);
  if (!waiting) return;
  const line =
    'The support assistant is offline right now. Your message is recorded and will be answered as soon as it is back.';
  const posted = await postInThread({ room, thread: waiting.thread, text: line }).catch((err) => {
    logger.error({ err, roomId: room.id }, 'support: the offline notice could not be posted');
    return null;
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted?.conversationId ?? waiting.conversationId,
    thread: waiting.thread,
    kind: 'refused',
    actorKind: 'core',
    tool: 'offline',
    output: { reason: 'no paired box of the project can run the session', posted: Boolean(posted) },
    externalId: posted?.messageId ?? null,
  });
}

/**
 * The recovery sweep (a process timer): a room still holding a message no turn took is offered one.
 * On the live path nothing waits here, since a message is handed on as it is recorded.
 */
export async function drainSupportRooms(): Promise<void> {
  for (const roomId of await roomsWithUndelivered()) {
    await deliverWaiting(roomId).catch((err) =>
      logger.error({ err, roomId }, 'support: delivering waiting messages failed'),
    );
  }
}

/** The bridge a support session's turn end fires: the room's waiting messages go next. */
export async function onSupportTurnEnded(row: SessionRow): Promise<void> {
  const marker = (row.metadata as Record<string, unknown> | null)?.supportRoom as
    | { roomId?: unknown }
    | undefined;
  if (typeof marker?.roomId !== 'string') return;
  if (!COMPLETED.has(row.status)) await tellTurnFailed(marker.roomId, row.status);
  // what the box refused to write into the turn now waits again, and goes with the rest
  await settleInjects(marker.roomId);
  await deliverWaiting(marker.roomId);
}

/** The ends of a turn that finished it; every other end left its messages unanswered. */
const COMPLETED = new Set<string>(['completed', 'completed_via_recovery']);

const TURN_FAILED_LINE =
  'I could not finish answering this message, so it has no answer from me. Please send it again; it is recorded in Forge for the team.';

/**
 * A turn that failed or was cancelled tells each thread it left unanswered, once, and records why:
 * the messages stay delivered, so a box that fails every turn is never handed them again. A message
 * a failed turn was already reported for is not reported again by a later one; a warm-up that fails
 * reports only what was written into it.
 */
async function tellTurnFailed(roomId: string, status: string): Promise<void> {
  const room = await roomById(roomId);
  if (!room) return;
  const taken = await unansweredOfLastTurn(room.id, lastTurn.get(room.id) ?? null);
  const told = await toldFailed(
    room.id,
    taken.map((m) => m.id),
  );
  const left = taken.filter((m) => !told.has(m.id));
  const threads = new Map(left.map((m) => [m.thread, m] as const));
  for (const [thread, first] of threads) {
    const posted = await postInThread({ room, thread, text: TURN_FAILED_LINE }).catch((err) => {
      logger.error({ err, roomId, thread }, 'support: the failed-turn notice could not be posted');
      return null;
    });
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: posted?.conversationId ?? first.conversationId,
      thread,
      kind: 'refused',
      actorKind: 'core',
      tool: 'turn_failed',
      output: {
        reason: `the session's turn ended ${status} before it answered`,
        messages: left.filter((m) => m.thread === thread).map((m) => m.id),
        posted: Boolean(posted),
      },
      externalId: posted?.messageId ?? null,
    });
  }
}
