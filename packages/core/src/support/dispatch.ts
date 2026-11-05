// Handing a support group's messages to its session (REQ-75 BC-11, BC-16). The session is a `chat`
// row the existing chat-turn path drives on a paired box of the project, and the box keeps its
// Claude Code process resident between turns (`keepResident`), so a turn is written into a warm
// process rather than a fresh spawn. A message goes to the session the moment it is recorded: as a
// turn of its own when none runs, or written into the running turn (`inject.ts`), which Claude Code
// takes at its next tool call or answers straight after it. The drain timer only recovers what a
// crash left undelivered, and re-offers a room whose back-off ended. A turn that ends without
// completing, or never reaches its box, gives the messages it left unanswered back to be tried again,
// and tells a thread only once its tries ran out (`turn-retry.ts`, ISS-977). A turn whose end core
// never heard, as one cut off by a core restart, is read lost once it goes silent (`lost-turns.ts`,
// ISS-850), and its messages are tried again the same way.

import type { SupportDeliveryPath, SupportRoomConfig, SupportTool } from '@forge/contracts/support';
import type { ChatRole } from '@forge/contracts/support-operations';
import {
  type CheckoutView,
  dispatchChatTurn,
  mintFencedSessionCredential,
  pushProjectNow,
  sessionRowById,
  turnCredentialChatDevice,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import type { agentSessions } from '../db/schema.js';
import { findBindingWithConnectionById, forgeReads } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import { activeSupportApi } from '../integrations/support-api/index.js';
import { resolveSessionRepoPathForDevice } from '../lib/device-pool.js';
import { logger } from '../lib/logger.js';
import { RefusalError } from '../lib/refusal.js';
import { buildBaseOf, buildKeyOf } from './build.js';
import { briefChannel, channelNews } from './channel-read.js';
import {
  claimUndelivered,
  hasReady,
  roomsWithUndelivered,
  unansweredOfLastTurn,
  unclaim,
  undeliveredThreads,
} from './delivery.js';
import { answersOfConfig, grantsOf, readersOfConfig, supportConfigOf } from './grants.js';
import { injectWaiting, settleInjects } from './inject.js';
import { tellLastResort } from './last-resort.js';
import { operationsBrief } from './ops-prompt.js';
import { roleOfRoom } from './ops-role.js';
import { projectsInScope } from './ops-scope.js';
import { ownViewOf } from './owner-git.js';
import { agentOpening, coldThreads, roomMessages, supportBrief } from './prompt.js';
import { agentMarkerOf, ensureSupportRoom, roomIsBound } from './rooms.js';
import { insertAction, type RoomRow, roomById, roomsOfSession } from './store.js';
import { retryOrTell } from './turn-retry.js';

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

/**
 * The tools each room's session was last told of. A session briefed once and kept warm is told
 * again when the project's grants change (`warm.ts:retellTools`); core restarting forgets, and the
 * next grant change tells it again.
 */
const briefedTools = new Map<string, string>();
/** What a support group's session was briefed with: its tools, and its room's persona, readers and grant. */
export const toolsKey = (tools: readonly SupportTool[], config: SupportRoomConfig | null) =>
  JSON.stringify([
    tools.map((t) => [t.name, t.kind, t.summary]),
    config?.persona ?? null,
    config?.readers ?? null,
    config?.answers ?? null,
    config?.grants ?? null,
    config?.projects ?? null,
    config?.rooms ?? null,
  ]);
export function toldTools(roomId: string): string | undefined {
  return briefedTools.get(roomId);
}
export function noteTools(
  roomId: string,
  tools: readonly SupportTool[],
  config: SupportRoomConfig | null,
): void {
  briefedTools.set(roomId, toolsKey(tools, config));
}
/** What an operations room's session was briefed with: its role, which a connection edit can change. */
export const roleKey = (role: ChatRole) => JSON.stringify([role.name, role.persona, role.grants]);
export function noteRole(roomId: string, role: ChatRole): void {
  briefedTools.set(roomId, roleKey(role));
}

export type SessionRow = typeof agentSessions.$inferSelect;
export type TurnClient = Awaited<ReturnType<typeof turnCredentialChatDevice>>;

export async function sessionOf(room: RoomRow): Promise<SessionRow | null> {
  return room.sessionId ? sessionRowById(room.sessionId) : null;
}

/**
 * The room as it stands, its session declared if its binding is on and still names it as it was
 * declared. A room its binding no longer answers gets none: the sweep released it (ISS-933).
 */
export async function roomWithSession(roomId: string): Promise<RoomRow | null> {
  const room = await roomById(roomId);
  if (!room || room.sessionId || !(await roomIsBound(room))) return room;
  const pair = await findBindingWithConnectionById(room.bindingId);
  const config = (pair?.binding.config ?? null) as RocketChatBindingConfig | null;
  const declared =
    room.kind === 'operations'
      ? config?.operations
        ? ({ kind: 'operations', scope: config.operations.scope } as const)
        : null
      : room.kind === 'agent'
        ? config?.agent
          ? ({ kind: 'agent', agent: config.agent } as const)
          : null
        : config?.support
          ? ({ kind: 'support', support: config.support } as const)
          : null;
  if (!declared) return room;
  return ensureSupportRoom({
    projectId: room.projectId,
    bindingId: room.bindingId,
    connectionId: room.connectionId,
    rid: room.rid,
    room: declared,
  });
}

/**
 * A cold session's brief: a support group's (the product, its granted tools), or an operations
 * room's (its role's persona and grants, its reach). An operations room whose bot has no role it can
 * read is not briefed at all: the turn throws, naming why, and its messages wait.
 */
async function briefOf(
  room: RoomRow,
  projectName: string,
  followed: readonly FollowedCheckout[],
): Promise<string> {
  if (room.kind === 'operations') {
    const role = await roleOfRoom(room);
    if (!role.ok) throw new Error(`support: ${role.refusals[0]?.detail ?? 'no role'}`);
    noteRole(room.id, role.value);
    return [
      operationsBrief({
        role: role.value,
        scope: room.scope ?? 'project',
        reach: await projectsInScope(room),
      }),
      await briefChannel(room),
    ].join('\n\n');
  }
  const api = await activeSupportApi(room.projectId);
  const config = await supportConfigOf(room);
  noteTools(room.id, api?.tools ?? [], config);
  if (room.kind === 'agent') {
    return agentBriefOf(room, projectName, api?.tools ?? [], config, followed);
  }
  return supportBrief({
    projectName,
    product: config?.product ?? null,
    tools: api?.tools ?? [],
    config,
    channel: await briefChannel(room),
  });
}

/**
 * A channel agent's brief (REQ-77): one for every group its session answers, each group's channel
 * record after it. Every room of the session is noted told, so a grant change re-tells it once.
 */
async function agentBriefOf(
  room: RoomRow,
  projectName: string,
  tools: readonly SupportTool[],
  config: SupportRoomConfig | null,
  followed: readonly FollowedCheckout[],
): Promise<string> {
  const rooms = room.sessionId ? await roomsOfSession(room.sessionId) : [room];
  for (const r of rooms) noteTools(r.id, tools, config);
  const records = (await Promise.all(rooms.map((r) => briefChannel(r)))).filter(Boolean);
  return supportBrief({
    projectName,
    product: config?.product ?? null,
    tools,
    config,
    channel: records.join('\n\n') || null,
    opening: agentOpening({
      projectName,
      product: config?.product ?? null,
      channels: rooms.map((r) => r.rid),
      ownerMode: Boolean(config?.grants?.abilities.includes('owner_mode')),
      ownerRoom: config?.ownerRoom ?? null,
      followed,
      // each group's own readers and answers, where the binding sets them per group (ISS-874)
      rooms: config?.rooms
        ? rooms.map((r) => ({
            rid: r.rid,
            readers: readersOfConfig(r, config),
            answers: answersOfConfig(r, config),
          }))
        : [],
    }),
  });
}

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
  const followed = await followedCheckouts(room, client.deviceId);
  if (startsCold(session, client)) {
    parts.push(await briefOf(room, project.name, followed));
    // a channel agent re-reads every group it answers, each thread naming its channel
    const rooms = room.kind === 'agent' ? await roomsOfSession(session.id) : [room];
    for (const r of rooms) {
      const history = await coldThreads(r);
      if (history) parts.push(rooms.length > 1 ? `In channel ${r.rid}:\n${history}` : history);
    }
    if ('messages' in body) parts.push('New messages:');
  } else if ('messages' in body) {
    // a warm session reads the channel record again when it changed since it was told (BC-41)
    const news = await channelNews(room);
    if (news) parts.push(news, 'New messages:');
  }
  parts.push('messages' in body ? body.messages : body.warmUp);
  const credential = await mintFencedSessionCredential({
    sessionId: session.id,
    deviceId: client.deviceId,
    userId: room.principalUserId,
    projectId: room.projectId,
    permissions: SUPPORT_SESSION_GRANT,
  });
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
  | 'dispatched'
  | 'dispatch-failed';

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

async function handOn(room: RoomRow): Promise<DeliverOutcome> {
  const session = await sessionOf(room);
  if (!session) return 'nothing-waiting';
  if (session.status === 'running') return injectWaiting(room, session);
  if (!(await hasReady(room.id))) return 'backing-off';

  const client = await turnCredentialChatDevice(session);
  if (!client.deviceId) {
    await tellOffline(room);
    return 'no-box';
  }

  const at = new Date();
  const path: SupportDeliveryPath = startsCold(session, client) ? 'start' : 'send';
  const rows = await claimUndelivered(room.id, at, path);
  if (rows.length === 0) return 'nothing-waiting';
  noteTurn(room.id, at);
  try {
    await handTurn(
      room,
      session,
      { ...client, deviceId: client.deviceId },
      {
        messages: await roomMessages(room, rows),
      },
    );
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

const refusedAs = (err: unknown, code: string) =>
  err instanceof RefusalError && err.refusals.some((r) => r.code === code);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Tell each thread with a message waiting that its assistant has no box to run on, once; the messages wait. */
async function tellOffline(room: RoomRow): Promise<void> {
  for (const waiting of await undeliveredThreads(room.id)) {
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
    // what the box refused to write into the turn now waits again, and goes with the rest
    await settleInjects(roomId);
    await deliverWaiting(roomId);
  }
  // the turn ended: the rooms it answered read quiet or waiting on the project's pages (REQ-15 BC-10)
  await pushProjectNow(db, row.projectId, 'rooms');
}

/** The ends of a turn that finished it; every other end left its messages unanswered. */
const COMPLETED = new Set<string>(['completed', 'completed_via_recovery']);

/**
 * A turn that failed or was cancelled gives back each message it took and left unanswered, to be
 * tried again, naming the end as the try's cause (ISS-977); a warm-up that fails gives back only
 * what was written into it.
 */
async function retryFailedTurn(roomId: string, row: SessionRow): Promise<void> {
  const room = await roomById(roomId);
  if (!room) return;
  // a message handed to the next turn after this one ended is that turn's, not this one's
  const taken = await unansweredOfLastTurn(room.id, lastTurn.get(room.id) ?? null, row.updatedAt);
  const why = [row.failureReason, row.failureDetail].filter(Boolean).join(': ');
  await retryOrTell(
    room,
    taken,
    `the session's turn ended ${row.status} before it answered${why ? ` (${why})` : ''}`,
  );
}
