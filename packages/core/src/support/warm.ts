// A support group's or an operations room's session is warm before anyone writes (REQ-75 BC-11): its Claude Code process is
// spawned, briefed and left resident on the box when the room is bound, when a box of the project
// comes online, and whenever the sweep finds it not resident, so a member's first message is
// written into a running process instead of waiting on a cold start. Warming is one short turn
// that answers nothing; the box keeps the process for as long as the room is bound
// (`jobs/park-deadline.ts:closeIdleResidents` never closes it).

import { turnCredentialChatDevice } from '../agent-sessions/index.js';
import { forgeReads } from '../integrations/index.js';
import { logger } from '../lib/logger.js';
import { RefusalError } from '../lib/refusal.js';
import { deviceProjectIds } from '../runners/index.js';
import { briefStale } from './brief-told.js';
import { hasReady, roomsOfProjects, roomsToWarm } from './delivery.js';
import { deliverWaiting, followedCheckouts, handTurn, noteTurn } from './dispatch.js';
import { replayPlacedRooms } from './replay.js';
import { roomWithSession, sessionToHand } from './room-session.js';
import {
  declareSupportRooms,
  projectsWithUndeclaredRooms,
  releaseUnboundRooms,
  roomIsBound,
} from './rooms.js';
import { roomById } from './store.js';

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
  | 'unbound'
  | 'held'
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
  const found = await roomById(roomId);
  if (!found) return 'none';
  // a room whose binding is off or no longer names its group is not answered, so it is not warmed
  if (!(await roomIsBound(found))) return 'unbound';
  const declared = await roomWithSession(roomId);
  if (!declared) return 'none';
  // a session that ended is never warmed again; one ended on a cause its checkout meets again is
  // not replaced until a person's act (a binding saved, a box online) may have cleared it (ISS-1101)
  const { room, session, held } = await sessionToHand(declared, { lift: why !== 'sweep' });
  if (held) return 'held';
  if (!session) return 'none';
  if (session.status === 'running' || session.status === 'queued') return 'busy';
  // a member's message beats a warm-up: it is the turn that warms the session; one backing off from
  // a failed try does not hold the warm-up back, whose completing ends that back-off (ISS-977)
  if (await hasReady(room.id)) {
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
    // the warm-up carries the brief again, since a binding change may have changed it (`brief-told.ts`)
    const [project] = await forgeReads().projectsByIds([room.projectId]);
    const followed = await followedCheckouts(room, box.deviceId);
    if (!project || !(await briefStale(room, session, project.name, followed))) return 'resident';
    noteTurn(room.id, new Date());
    if (await startedBeside(handTurn(room, session, box, { warmUp: WARM_UP_LINE }))) return 'busy';
    return 'retold';
  }
  lastTried.set(room.id, Date.now());
  // noted before it is handed over: a warm-up can end before the hand-over returns
  noteTurn(room.id, new Date());
  if (await startedBeside(handTurn(room, session, box, { warmUp: WARM_UP_LINE }))) return 'busy';
  return 'warmed';
}

/**
 * Whether the hand-over was refused because a turn of the session started since it was read: core
 * runs one turn of a session at a time (ISS-977), so the warm-up waits for that turn's end.
 */
async function startedBeside(handOver: Promise<void>): Promise<boolean> {
  try {
    await handOver;
    return false;
  } catch (err) {
    if (err instanceof RefusalError && err.refusals.some((r) => r.code === 'SESSION_RUNNING'))
      return true;
    throw err;
  }
}

/** Release the rooms a project's bindings no longer answer, and warm every room they do, as a binding is saved. */
export async function warmProjectRooms(projectId: string): Promise<void> {
  // a binding switched off, or no longer naming a room, lets that room go (ISS-933)
  await releaseUnboundRooms(projectId);
  for (const room of await declareSupportRooms(projectId)) {
    await warmSupportRoom(room.id, 'bindings').catch((err) =>
      logger.error({ err, roomId: room.id }, 'support: warming a room failed'),
    );
  }
  // a room placed now is handed what its group said while nothing answered it (ISS-933)
  await replayPlacedRooms(projectId);
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
 * The sweep: a room its binding names but nobody declared is declared, a room whose session is not
 * resident is warmed, at most once a minute, one whose session is gone is given a new one and
 * warmed, and one whose grant change arrived mid-turn is told the new tools now.
 */
export async function warmColdRooms(): Promise<void> {
  // a room its binding no longer answers lets go of its session, and a room an active binding names
  // but nobody declared is declared, then warmed below (ISS-933)
  await releaseUnboundRooms().catch((err) =>
    logger.error({ err }, 'support: releasing unbound rooms failed'),
  );
  for (const projectId of await projectsWithUndeclaredRooms()) {
    await declareSupportRooms(projectId).catch((err) =>
      logger.error({ err, projectId }, 'support: declaring a bound room failed'),
    );
  }
  // a room placed since the last sweep is handed what its group said while nothing answered it
  await replayPlacedRooms();
  const now = Date.now();
  for (const { id: roomId, sessionId } of await roomsToWarm()) {
    const why: WarmReason = retellOwed.has(roomId) ? 'bindings' : 'sweep';
    const tried = lastTried.get(roomId);
    // a room whose session is gone is given one at once: nothing answers it until then
    if (why === 'sweep' && sessionId && tried && now - tried < WARM_RETRY_MS) continue;
    const out = await warmSupportRoom(roomId, why).catch((err) => {
      logger.error({ err, roomId }, 'support: warming a room failed');
      return 'none' as const;
    });
    if (out === 'no-box') lastTried.set(roomId, now);
  }
}
