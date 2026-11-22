// Handing a support group's messages to its session (REQ-75 BC-11, BC-16). The session is a `chat`
// row the existing chat-turn path drives on a paired box of the project, and the box keeps its
// Claude Code process resident between turns (`keepResident`), so a turn is written into a warm
// process rather than a fresh spawn. A message goes to the session the moment it is recorded: as a
// turn of its own when none runs, or written into the running turn (`inject.ts`), which Claude Code
// takes at its next tool call or answers straight after it. The drain timer only recovers what a
// crash left undelivered, and re-offers a room whose back-off ended. A turn that ends without
// completing, or never reaches its box, gives the messages it left unanswered back to be tried again,
// and tells the room once, at its top level, only once their tries ran out (`turn-retry.ts`, ISS-977,
// ISS-1105); a message held past the age bound is dropped and told nowhere. A turn whose end core
// never heard, as one cut off by a core restart, is read lost once it goes silent (`lost-turns.ts`,
// ISS-850), and its messages are tried again the same way.

import type { SupportDeliveryPath } from '@forge/contracts/support';
import {
  type CheckoutView,
  checkoutMovedFrom,
  dispatchChatTurn,
  fencedSessionCredential,
  pushProjectNow,
  sessionRowById,
  turnCredentialChatDevice,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { forgeReads } from '../integrations/index.js';
import { resolveSessionRepoPathForDevice } from '../lib/device-pool.js';
import { logger } from '../lib/logger.js';
import { RefusalError } from '../lib/refusal.js';
import { briefNews, coldBrief } from './brief-told.js';
import { buildBaseOf, buildKeyOf } from './build.js';
import { channelNews } from './channel-read.js';
import {
  claimUndelivered,
  endBackOff,
  hasReady,
  roomsWithUndelivered,
  unansweredOfLastTurn,
  unclaim,
  undeliveredThreads,
  waitingMessages,
} from './delivery.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { leftToBoxProcess } from './hand-off.js';
import { injectWaiting, settleInjects } from './inject.js';
import { endRoomLastResortWait, OFFLINE_GRACE_MS, tellLastResort } from './last-resort.js';
import { answeredSince } from './one-voice.js';
import { projectsInScope } from './ops-scope.js';
import { ownViewOf } from './owner-git.js';
import { coldThreads, roomMessages } from './prompt.js';
import { roomLessonsNews } from './reply-audit/lessons-news.js';
import { noteTurnCarried } from './room-reaches.js';
import { roomWithSession, type SessionRow, sessionOf, sessionToHand } from './room-session.js';
import { agentMarkerOf } from './rooms.js';
import { openSessionTurn } from './session-turns.js';
import { threadHeldByAnother } from './shared-group.js';
import { insertAction, type RoomRow, roomById, roomsOfSession } from './store.js';
import { lastSessionAct } from './turn-acts.js';
import {
  dropHeldTooLong,
  retryOrRecordUnanswered,
  retryOrTell,
  tellUnanswered,
} from './turn-retry.js';

/** The one grant a support session's token carries: the project's routes, which it may not read. */
const SUPPORT_SESSION_GRANT = ['projects:write'] as const;

/**
 * When each room last handed its session a turn. Read when that turn ends, to tell only the threads
 * it took (and those written into it); core restarting in between leaves it unknown, and the newest
 * hand-over is read instead.
 */
const lastTurn = new Map<string, Date>();
export function noteTurn(roomId: string, at: Date): void {
  lastTurn.set(roomId, at);
}

export type TurnClient = Awaited<ReturnType<typeof turnCredentialChatDevice>>;

/** A project a channel agent follows besides its home (ISS-874), and its checkout on the turn's box. */
export interface FollowedCheckout {
  slug: string;
  name: string;
  /** The box's checkout of it, which the session reads read-only; null where the box holds none. */
  path: string | null;
}

/**
 * The checkouts, on `deviceId`, of the projects a channel agent follows besides its home: each
 * project's own checkout on that box, as the box registered it for that project. A project the box
 * holds no checkout of is named with none, so the brief says its code is not there.
 */
export async function followedCheckouts(
  room: RoomRow,
  deviceId: string | null,
): Promise<FollowedCheckout[]> {
  if (room.kind !== 'agent') return [];
  const followed = (await projectsInScope(room)).filter((p) => p.id !== room.projectId);
  return Promise.all(
    followed.map(async (p) => ({
      slug: p.slug,
      name: p.name,
      path: await resolveSessionRepoPathForDevice(p.id, deviceId),
    })),
  );
}

/**
 * How a support group's session sees the project's checkout (REQ-75 r5 BC-27): a writable copy of
 * the development branch when granted build (and the project names one apart from production's),
 * the checkout read-only when granted read_checkout, and an empty folder otherwise. An operations
 * room keeps the checkout as it was before r5. A channel agent always reads the checkout (REQ-77
 * BC-2), or builds in a copy when granted build; in owner mode it works in its own clone of the
 * repository, confined like every other session (ISS-765, `owner-git.ts`).
 */
export async function checkoutViewOf(
  room: RoomRow,
  followed: readonly FollowedCheckout[] = [],
): Promise<CheckoutView | null> {
  if (room.kind === 'operations') return null;
  const view = await homeViewOf(room);
  // the projects a channel agent follows are read-only in every mode, owner mode's included (ISS-874)
  const siblings = followed.flatMap((f) => (f.path ? [f.path] : []));
  return siblings.length > 0 ? { ...view, siblings } : view;
}

async function homeViewOf(room: RoomRow): Promise<CheckoutView> {
  const grants = grantsOf(await supportConfigOf(room));
  if (room.kind === 'agent' && (await ownerModeSession(room))) return ownViewOf(room);
  if (grants.abilities.includes('build')) {
    const base = await buildBaseOf(room.projectId);
    if (base.ok) return { mode: 'build', base: base.value.base, key: buildKeyOf(room) };
  }
  return room.kind === 'agent' || grants.abilities.includes('read_checkout')
    ? { mode: 'read' }
    : { mode: 'none' };
}

/** Whether the room's session was placed in owner mode: its marker, fixed when it was made. */
async function ownerModeSession(room: RoomRow): Promise<boolean> {
  const session = room.sessionId ? await sessionRowById(room.sessionId) : null;
  return agentMarkerOf(session?.metadata)?.ownerMode === true;
}

/**
 * Whether a turn of this session starts Claude Code cold: no session of its own to resume, a box
 * other than the one it ran on, or a checkout other than the one it ran in (ISS-1101), which
 * `chat-turn.ts` starts fresh, so the turn is briefed as a first one.
 */
export async function startsCold(
  session: SessionRow,
  client: TurnClient & { deviceId: string },
  projectId: string,
): Promise<boolean> {
  if (!session.claudeSessionId || client.migrated) return true;
  const bound = await resolveSessionRepoPathForDevice(projectId, client.deviceId);
  return checkoutMovedFrom(session, client.deviceId, bound) !== null;
}

/**
 * Hand `body` to the session as one turn, under the token fenced to the project the session holds
 * across its turns (ISS-1202). A cold turn is briefed first and re-reads its threads. `onTurn` is
 * told the turn's id before the turn is handed anywhere. Throws when the turn does not reach its box.
 */
export async function handTurn(
  room: RoomRow,
  session: SessionRow,
  client: TurnClient & { deviceId: string },
  body: { messages: string } | { warmUp: string } | { direct: string },
  onTurn?: (turnId: string) => Promise<void>,
): Promise<void> {
  const [project] = await forgeReads().projectsByIds([room.projectId]);
  if (!project) throw new Error(`support: room ${room.id}'s project ${room.projectId} is gone`);
  const parts: string[] = [];
  const followed = await followedCheckouts(room, client.deviceId);
  const cold = await startsCold(session, client, room.projectId);
  // the project's lessons about chat replies, on a cold turn and whenever they changed (ISS-1250)
  const lessons = 'warmUp' in body && !cold ? null : await roomLessonsNews(room, cold);
  if (cold) {
    const brief = await coldBrief(room, session, project.name, followed);
    parts.push(brief);
    if (lessons) parts.push(lessons);
    // what the turn was given, kept as a run's is: the lessons and cards its brief carries (ISS-1251)
    noteTurnCarried(room, session.id, [brief, lessons ?? ''].join('\n\n'));
    // a channel agent re-reads every group it answers, each thread naming its channel
    const rooms = room.kind === 'agent' ? await roomsOfSession(session.id) : [room];
    for (const r of rooms) {
      const history = await coldThreads(r);
      if (history) parts.push(rooms.length > 1 ? `In channel ${r.rid}:\n${history}` : history);
    }
    if ('messages' in body) parts.push('New messages:');
  } else {
    // a resident session is told its brief again once this build renders it otherwise (ISS-1251), and
    // the channel record again when it changed since it was told (BC-41)
    const retold = await briefNews(room, session, project.name, followed);
    const news = 'warmUp' in body ? null : await channelNews(room);
    const told = [retold, news, lessons].filter((p): p is string => p !== null);
    if (retold || lessons) noteTurnCarried(room, session.id, [retold, lessons].join('\n\n'));
    if (told.length > 0) {
      parts.push(...told);
      if ('messages' in body) parts.push('New messages:');
    }
  }
  parts.push('messages' in body ? body.messages : 'direct' in body ? body.direct : body.warmUp);
  // the turn is opened, and the token read or minted, once the turn holds the session: a hand-over
  // refused beside a running turn opens no turn and re-mints nothing that turn runs under (ISS-977)
  const credential = async () => {
    const turnId = await openSessionTurn(session.id);
    await onTurn?.(turnId);
    return fencedSessionCredential({
      sessionId: session.id,
      deviceId: client.deviceId,
      userId: room.principalUserId,
      projectId: room.projectId,
      permissions: SUPPORT_SESSION_GRANT,
    });
  };
  const checkout = await checkoutViewOf(room, followed);
  await dispatchChatTurn({
    session,
    project: { id: project.id, slug: project.slug },
    client,
    message: parts.join('\n\n'),
    preBuilt: true,
    credential,
    actor: { type: 'system' },
    ...(checkout ? { checkout } : {}),
  });
}

export type DeliverOutcome =
  | 'nothing-waiting'
  | 'turn-running'
  | 'injected'
  | 'backing-off'
  | 'no-box'
  | 'elsewhere'
  | 'dispatched'
  | 'dispatch-failed'
  | 'held';

/**
 * Hand every message waiting in a room to its session at once: written into the running turn when
 * one runs, else as a turn of its own. A room whose every waiting message is backing off from a
 * failed try waits (`turn-retry.ts`); one message ready takes the rest along. A turn that could not
 * be handed to a box gives its messages back as a failed try. Finding no box online is not a failed
 * try and arms no back-off: each waiting thread is told once (`tellOffline`), and the messages go
 * the moment a box can take them.
 */
export async function deliverWaiting(roomId: string): Promise<DeliverOutcome> {
  const room = await roomWithSession(roomId);
  if (!room) return 'nothing-waiting';
  const outcome = await handOn(room);
  // a message taken or a turn started moves the room's turn the project's pages read (REQ-15 BC-10)
  if (outcome === 'injected' || outcome === 'dispatched') {
    await pushProjectNow(db, room.projectId, 'rooms');
  }
  return outcome;
}

/**
 * Hand each room what core recorded for it, once each: a room told several notes in one pass takes
 * them as one turn, so the notes one thread holds are answered in one post (ISS-1117).
 */
export async function handOnRooms(rooms: ReadonlySet<string>): Promise<void> {
  for (const roomId of rooms) {
    await deliverWaiting(roomId).catch((err) =>
      logger.error({ err, roomId }, 'support: a note waits for the next turn'),
    );
  }
}

async function handOn(found: RoomRow): Promise<DeliverOutcome> {
  const { room, session, held } = await sessionToHand(found);
  // a message held past the age bound goes to no turn and is told nowhere (ISS-1105)
  await dropHeldTooLong(room);
  if (held) return holdWaiting(room, held);
  if (!session) return 'nothing-waiting';
  if (session.status === 'running') return injectWaiting(room, session);
  if (!(await hasReady(room.id))) return 'backing-off';

  const client = await turnCredentialChatDevice(session);
  if (!client.deviceId) {
    await tellOffline(room);
    return 'no-box';
  }
  // the box reads another core process: that one's drain takes the messages (ISS-1231)
  if (await leftToBoxProcess(room.id, client.deviceId)) return 'elsewhere';

  const at = new Date();
  const box = { ...client, deviceId: client.deviceId };
  const path: SupportDeliveryPath = (await startsCold(session, box, room.projectId))
    ? 'start'
    : 'send';
  const rows = await claimUndelivered(room.id, at, path);
  if (rows.length === 0) return 'nothing-waiting';
  noteTurn(room.id, at);
  try {
    await handTurn(room, session, box, { messages: await roomMessages(room, rows) });
    return 'dispatched';
  } catch (err) {
    // a turn started since the session was read: the messages go into it, and spend no try (ISS-977)
    if (refusedAs(err, 'SESSION_RUNNING')) {
      await unclaim(
        rows.map((r) => r.id),
        at,
      );
      const running = await sessionOf(room);
      return running?.status === 'running' ? injectWaiting(room, running) : 'turn-running';
    }
    logger.error(
      { err, roomId: room.id, sessionId: session.id },
      'support: the turn did not reach its box',
    );
    await retryOrTell(room, rows, `the turn did not reach its box: ${errorText(err)}`, { at });
    return 'dispatch-failed';
  }
}

/**
 * The room's session ended on a cause its checkout meets again (`room-session.ts`): nothing is
 * handed to a turn, and the room is told once, at its top level, as soon as a message waits on an
 * answer: the hand-over of that message, or the drain's next tick, runs this (ISS-1105). The
 * messages wait for the binding to name another checkout, each until the age bound drops it.
 */
async function holdWaiting(room: RoomRow, held: SessionRow): Promise<DeliverOutcome> {
  const why = `the session's checkout ${held.repoPath ?? '(none)'} failed its last turn (${held.failureReason}) and the binding still names it`;
  await tellUnanswered(room, await waitingMessages(room.id), why);
  return 'held';
}

const refusedAs = (err: unknown, code: string) =>
  err instanceof RefusalError && err.refusals.some((r) => r.code === code);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Tell each thread whose message has waited past the grace window that its assistant has no box to
 * run on, once; the messages wait. A box back within the window, or a master's or the agent's answer
 * in it, leaves the thread told nothing (ISS-1406); the drain's next tick reads the window again.
 */
async function tellOffline(room: RoomRow): Promise<void> {
  const now = Date.now();
  for (const waiting of await undeliveredThreads(room.id)) {
    if (now - waiting.since.getTime() < OFFLINE_GRACE_MS) continue;
    if (await answeredSince(room, waiting.thread, waiting.last)) continue;
    // a thread another binding of a shared group holds is told nothing by this one (ISS-1243)
    if (await threadHeldByAnother(room, waiting.thread)) continue;
    const told = await tellLastResort(room, waiting.thread, 'offline');
    if (!told.posted && told.why !== 'post-failed') continue;
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: told.posted ? told.conversationId : waiting.conversationId,
      thread: waiting.thread,
      kind: 'refused',
      actorKind: 'core',
      tool: 'offline',
      output: { reason: 'no paired box of the project can run the session', posted: told.posted },
      externalId: told.posted ? told.messageId : null,
    });
  }
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

/**
 * The bridge a support session's turn end fires: the room's waiting messages go next. A channel
 * agent's session answers every group of its binding, so each of them is handed on (REQ-77).
 */
export async function onSupportTurnEnded(row: SessionRow): Promise<void> {
  const marker = (row.metadata as Record<string, unknown> | null)?.supportRoom as
    | { roomId?: unknown }
    | undefined;
  if (typeof marker?.roomId !== 'string') return;
  const served = agentMarkerOf(row.metadata)
    ? (await roomsOfSession(row.id)).map((r) => r.id)
    : [marker.roomId];
  for (const roomId of served) {
    if (!COMPLETED.has(row.status)) await retryFailedTurn(roomId, row);
    else {
      // a completed turn shows the fault cleared: what waited out a back-off goes with the next
      // turn, and a later break is told to the room again (ISS-1105)
      await endBackOff(roomId);
      await endRoomWait(roomId);
      // and what it left with nothing said is handed again, or recorded unanswered (ISS-1007)
      await retryUnansweredTurn(roomId, row);
    }
    // what the box refused to write into the turn now waits again, and goes with the rest
    await settleInjects(roomId);
    await deliverWaiting(roomId);
  }
  // the turn ended: the rooms it answered read quiet or waiting on the project's pages (REQ-15 BC-10)
  await pushProjectNow(db, row.projectId, 'rooms');
}

async function endRoomWait(roomId: string): Promise<void> {
  const room = await roomById(roomId);
  if (!room) return;
  await endRoomLastResortWait(room).catch((err) =>
    logger.error({ err, roomId }, "support: the room's last-resort wait could not be ended"),
  );
}

/**
 * A completed turn that took no act at all for the messages it was handed: they are handed again, or
 * recorded unanswered (ISS-1007). A turn that acted in its room chose what to answer.
 */
async function retryUnansweredTurn(roomId: string, row: SessionRow): Promise<void> {
  const room = await roomById(roomId);
  if (!room) return;
  // core restarted since the hand-over: what the turn did is unknown here, and nothing is retried
  const handedAt = lastTurn.get(room.id);
  if (!handedAt) return;
  // a turn that took any act chose what to answer (REQ-77 BC-6); one that took none exited, and its
  // messages read as answered with no failure and no retry (the 1-3 s exits of 2026-11-01)
  const acted = lastSessionAct(row.id);
  if (acted && acted >= handedAt) return;
  const taken = await unansweredOfLastTurn(room.id, handedAt, row.updatedAt);
  await retryOrRecordUnanswered(room, taken);
}

/** The ends of a turn that finished it; every other end left its messages unanswered. */
export const COMPLETED = new Set<string>(['completed', 'completed_via_recovery']);

/**
 * A turn that failed or was cancelled gives back each message it took and left unanswered, to be
 * tried again, naming the end as the try's cause (ISS-977); a warm-up that fails gives back only
 * what was written into it. Given `holding`, only where that message is one of them: a write the box
 * refused after the turn ended runs this before its own give-back (`inject.ts:settleInjects`).
 */
export async function retryFailedTurn(
  roomId: string,
  row: SessionRow,
  holding?: string,
): Promise<void> {
  const room = await roomById(roomId);
  if (!room) return;
  // a message handed to the next turn after this one ended is that turn's, not this one's
  const taken = await unansweredOfLastTurn(room.id, lastTurn.get(room.id) ?? null, row.updatedAt);
  if (holding && !taken.some((m) => m.id === holding)) return;
  // the reason, never the detail: a detail can carry the turn's own prompt, members' words included
  const why = row.failureReason ? ` (${row.failureReason})` : '';
  await retryOrTell(room, taken, `the session's turn ended ${row.status} before it answered${why}`);
}
