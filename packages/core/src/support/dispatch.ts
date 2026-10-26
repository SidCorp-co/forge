// Handing a support group's waiting messages to its session (REQ-75 BC-11, BC-16). The session is a
// `chat` row the existing chat-turn path drives: a turn cold-starts Claude Code on a paired box of
// the project, a later one goes as `agent:send` with the stored Claude session id, which the box
// writes into its resident process or resumes with `--resume`. A message that arrives while a turn
// runs waits as an undelivered `message_in` row; the turn's end (`supportRoom` bridge) or the drain
// sends every waiting message as the next turn. A turn that ends without completing tells each
// thread it left unanswered so, and those messages are not handed to a turn again.

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
import { coldThreads, supportBrief, turnMessages } from './prompt.js';
import { ensureSupportRoom } from './rooms.js';
import {
  claimUndelivered,
  insertAction,
  offlineToldSince,
  oldestUndelivered,
  type RoomRow,
  roomById,
  roomsWithUndelivered,
  unansweredOfLastTurn,
  unclaim,
} from './store.js';
import { postInThread } from './thread.js';

/** The one grant a support session's token carries: the project's routes, which it may not read. */
const SUPPORT_SESSION_GRANT = ['projects:write'] as const;

/** How long a room whose dispatch failed waits before the drain tries it again. */
const RETRY_AFTER_MS = 30_000;
/** How often a room is told its assistant is offline, at most. */
const OFFLINE_NOTICE_EVERY_MS = 10 * 60_000;

const lastFailure = new Map<string, number>();

type SessionRow = typeof agentSessions.$inferSelect;

async function sessionOf(room: RoomRow): Promise<SessionRow | null> {
  return room.sessionId ? sessionRowById(room.sessionId) : null;
}

/** The room's binding config, for the brief's product line. */
async function roomProduct(room: RoomRow): Promise<string | null> {
  const pair = await findBindingWithConnectionById(room.bindingId);
  return (
    ((pair?.binding.config ?? null) as RocketChatBindingConfig | null)?.support?.product ?? null
  );
}

export type DeliverOutcome =
  | 'nothing-waiting'
  | 'turn-running'
  | 'backing-off'
  | 'no-box'
  | 'dispatched'
  | 'dispatch-failed';

/**
 * Send every message waiting in a room as one turn of its session, unless a turn is running (its
 * end sends them). A turn that could not be handed to a box gives its messages back.
 */
export async function deliverWaiting(roomId: string): Promise<DeliverOutcome> {
  let room = await roomById(roomId);
  if (!room) return 'nothing-waiting';
  if (!room.sessionId) {
    const pair = await findBindingWithConnectionById(room.bindingId);
    const config = (pair?.binding.config ?? null) as RocketChatBindingConfig | null;
    if (!config?.support) return 'nothing-waiting';
    room = await ensureSupportRoom({
      projectId: room.projectId,
      bindingId: room.bindingId,
      connectionId: room.connectionId,
      rid: room.rid,
      support: config.support,
    });
  }
  const session = await sessionOf(room);
  if (!session) return 'nothing-waiting';
  if (session.status === 'running') return 'turn-running';
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
  const [project] = await forgeReads().projectsByIds([room.projectId]);
  if (!project) throw new Error(`support: room ${room.id}'s project ${room.projectId} is gone`);

  // a turn without Claude's own session id starts cold: it is briefed, and re-reads its threads
  const cold = !session.claudeSessionId || client.migrated;
  const parts: string[] = [];
  if (cold) {
    const api = await activeSupportApi(room.projectId);
    parts.push(
      supportBrief({
        projectName: project.name,
        product: await roomProduct(room),
        tools: api?.tools ?? [],
      }),
    );
    const history = await coldThreads(room);
    if (history) parts.push(history);
    parts.push('New messages:');
  }
  parts.push(turnMessages(rows));
  try {
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

/** The drain: every room holding a waiting message is offered a turn (a process timer). */
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
  await deliverWaiting(marker.roomId);
}

/** The ends of a turn that finished it; every other end left its messages unanswered. */
const COMPLETED = new Set<string>(['completed', 'completed_via_recovery']);

const TURN_FAILED_LINE =
  'I could not finish answering this message, so it has no answer from me. Please send it again; it is recorded in Forge for the team.';

/**
 * A turn that failed or was cancelled tells each thread it left unanswered, once, and records why:
 * the messages stay delivered, so a box that fails every turn is never handed them again.
 */
async function tellTurnFailed(roomId: string, status: string): Promise<void> {
  const room = await roomById(roomId);
  if (!room) return;
  const left = await unansweredOfLastTurn(room.id);
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
