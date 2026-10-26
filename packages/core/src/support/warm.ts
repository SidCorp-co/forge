// A support group's session is warm before anyone writes (REQ-75 BC-11): its Claude Code process is
// spawned, briefed and left resident on the box when the room is bound, when a box of the project
// comes online, and whenever the sweep finds it not resident, so a member's first message is
// written into a running process instead of waiting on a cold start. Warming is one short turn
// that answers nothing; the box keeps the process for as long as the room is bound
// (`jobs/park-deadline.ts:closeIdleResidents` never closes it).

import { turnCredentialChatDevice } from '../agent-sessions/index.js';
import { activeSupportApi } from '../integrations/support-api/index.js';
import { logger } from '../lib/logger.js';
import { deviceProjectIds } from '../runners/index.js';
import { hasUndelivered, roomsOfProjects, roomsWithSessions } from './delivery.js';
import {
  deliverWaiting,
  handTurn,
  noteTools,
  noteTurn,
  roomWithSession,
  sessionOf,
  toldTools,
  toolsKey,
} from './dispatch.js';
import { toolsLine } from './prompt.js';
import { declareSupportRooms } from './rooms.js';

/** What the warm-up turn says: no member is waiting, so the session answers nothing. */
export const WARM_UP_LINE =
  'No member message is waiting. Do not call any tool; reply with the single word: ready.';

/** How long a room whose warm-up did not reach a box waits before the sweep tries again. */
const WARM_RETRY_MS = 60_000;
const lastTried = new Map<string, number>();
/** Rooms whose grant change found the session busy: the sweep tells it once the turn has ended. */
const retellOwed = new Set<string>();

export type WarmOutcome =
  | 'warmed'
  | 'retold'
  | 'resident'
  | 'busy'
  | 'messages-waiting'
  | 'no-box'
  | 'none';

/**
 * Why a room is warmed: the sweep found it (a resident session is left alone), its project's
 * bindings changed (a resident session briefed on other tools than the project grants now is told
 * the new list, so a grant made after the room was bound reaches a session that stays warm), or a
 * box came online (warmed even if the row reads resident: the box may have restarted and kept
 * nothing, and a warm-up of a process still resident is one short turn).
 */
export type WarmReason = 'sweep' | 'bindings' | 'online';

export async function warmSupportRoom(roomId: string, why: WarmReason): Promise<WarmOutcome> {
  const out = await warmOnce(roomId, why);
  if (why === 'bindings' && (out === 'busy' || out === 'messages-waiting')) retellOwed.add(roomId);
  else if (why === 'bindings') retellOwed.delete(roomId);
  return out;
}

async function warmOnce(roomId: string, why: WarmReason): Promise<WarmOutcome> {
  const room = await roomWithSession(roomId);
  const session = room ? await sessionOf(room) : null;
  if (!room || !session) return 'none';
  if (session.status === 'running' || session.status === 'queued') return 'busy';
  // a member's message beats a warm-up: it is the turn that warms the session
  if (await hasUndelivered(room.id)) {
    await deliverWaiting(room.id);
    return 'messages-waiting';
  }
  const client = await turnCredentialChatDevice(session);
  if (!client.deviceId) return 'no-box';
  const resident =
    session.runtimeState === 'awaiting_input' &&
    session.deviceId === client.deviceId &&
    !client.migrated;
  const box = { ...client, deviceId: client.deviceId };
  if (resident && why === 'sweep') return 'resident';
  if (resident && why === 'bindings') {
    const tools = (await activeSupportApi(room.projectId))?.tools ?? [];
    if (toldTools(room.id) === toolsKey(tools)) return 'resident';
    noteTools(room.id, tools);
    noteTurn(room.id, new Date());
    await handTurn(room, session, box, { warmUp: `${toolsLine(tools)}\n\n${WARM_UP_LINE}` });
    return 'retold';
  }
  lastTried.set(room.id, Date.now());
  // noted before it is handed over: a warm-up can end before the hand-over returns
  noteTurn(room.id, new Date());
  await handTurn(room, session, box, { warmUp: WARM_UP_LINE });
  return 'warmed';
}

/** Warm every room of a project, as its binding is saved. */
export async function warmProjectRooms(projectId: string): Promise<void> {
  for (const room of await declareSupportRooms(projectId)) {
    await warmSupportRoom(room.id, 'bindings').catch((err) =>
      logger.error({ err, roomId: room.id }, 'support: warming a room failed'),
    );
  }
}

/** A box came online: every room of the projects it serves is warmed, resident or not. */
export async function warmRoomsOfDevice(deviceId: string): Promise<void> {
  for (const roomId of await roomsOfProjects(await deviceProjectIds(deviceId))) {
    await warmSupportRoom(roomId, 'online').catch((err) =>
      logger.error({ err, roomId, deviceId }, 'support: warming a room failed'),
    );
  }
}

/**
 * The sweep: a room whose session is not resident is warmed, at most once a minute, and one whose
 * grant change arrived mid-turn is told the new tools now.
 */
export async function warmColdRooms(): Promise<void> {
  const now = Date.now();
  for (const roomId of await roomsWithSessions()) {
    const why: WarmReason = retellOwed.has(roomId) ? 'bindings' : 'sweep';
    const tried = lastTried.get(roomId);
    if (why === 'sweep' && tried && now - tried < WARM_RETRY_MS) continue;
    const out = await warmSupportRoom(roomId, why).catch((err) => {
      logger.error({ err, roomId }, 'support: warming a room failed');
      return 'none' as const;
    });
    if (out === 'no-box') lastTried.set(roomId, now);
  }
}
