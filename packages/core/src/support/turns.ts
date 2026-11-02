// Each support room's turn as the project bar reads it (REQ-15 BC-10, ISS-856): answering while its
// session's turn runs, waiting while a member's message no turn took stands, quiet otherwise, with
// the room's newest act. The session's status is the session's own row; the waiting messages are
// the room's `message_in` rows no turn claimed (`delivery.ts:claimUndelivered`). Nothing else holds
// either fact, and this read writes nothing.

import type {
  SupportRoomTurn,
  SupportTurnState,
  SupportTurnsView,
} from '@forge/contracts/project-now';
import { inArray, sql } from 'drizzle-orm';
import { sessionStatusesByIds } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { requireDeclaredOn } from '../permissions/index.js';
import { roomsOfProject } from './store.js';

interface RoomFacts {
  waiting: number;
  waitingSince: Date | null;
  lastActivityAt: Date | null;
}

const NO_FACTS: RoomFacts = { waiting: 0, waitingSince: null, lastActivityAt: null };
const at = (v: unknown) => (v ? new Date(v as string) : null);

/** Per room: the members' messages no turn took, the oldest of them, and the newest act of anyone. */
async function factsOfRooms(roomIds: readonly string[]): Promise<Map<string, RoomFacts>> {
  if (roomIds.length === 0) return new Map();
  const waitingRow = sql`${supportActions.kind} = 'message_in' AND ${supportActions.deliveredAt} IS NULL`;
  const rows = await db
    .select({
      roomId: supportActions.roomId,
      waiting: sql<number>`count(*) FILTER (WHERE ${waitingRow})`.mapWith(Number),
      waitingSince: sql<unknown>`min(${supportActions.createdAt}) FILTER (WHERE ${waitingRow})`,
      lastActivityAt: sql<unknown>`max(${supportActions.createdAt})`,
    })
    .from(supportActions)
    .where(inArray(supportActions.roomId, [...roomIds]))
    .groupBy(supportActions.roomId);
  return new Map(
    rows.map((r) => [
      r.roomId,
      {
        waiting: r.waiting,
        waitingSince: at(r.waitingSince),
        lastActivityAt: at(r.lastActivityAt),
      },
    ]),
  );
}

export function turnStateOf(sessionStatus: string | null, waiting: number): SupportTurnState {
  if (sessionStatus === 'running') return 'answering';
  return waiting > 0 ? 'waiting' : 'quiet';
}

/** Every support room of the project with its turn, oldest room first. */
export async function supportTurnsOf(viewer: string, projectId: string): Promise<SupportTurnsView> {
  await requireDeclaredOn(projectId, viewer, 'project.read');
  const rooms = await roomsOfProject(projectId);
  const [statusOf, factsOf] = await Promise.all([
    sessionStatusesByIds(rooms.flatMap((r) => (r.sessionId ? [r.sessionId] : []))),
    factsOfRooms(rooms.map((r) => r.id)),
  ]);
  const turns: SupportRoomTurn[] = rooms.map((r) => {
    const facts = factsOf.get(r.id) ?? NO_FACTS;
    const status = r.sessionId ? (statusOf.get(r.sessionId)?.status ?? null) : null;
    return {
      roomId: r.id,
      rid: r.rid,
      kind: r.kind,
      state: turnStateOf(status, facts.waiting),
      waiting: facts.waiting,
      waitingSince: facts.waitingSince?.toISOString() ?? null,
      lastActivityAt: facts.lastActivityAt?.toISOString() ?? null,
    };
  });
  return { generatedAt: new Date().toISOString(), projectId, rooms: turns };
}
