// A room agent asks a master in its turn (ISS-1243 item 14), and the ask preempts the master (item
// 21). Owner, 2026-11-15: the bot asks the master itself rather than telling the person "I passed it
// to the team, I'll let you know", and the master answers an agent's ask before anything else.
//
// What it reuses: the ask is written with an outbox event in one transaction, and the `master-wake`
// consumer publishes `master.wake` to the project's boxes at once (`ws/master-wake.ts`), as an agreed
// requirement or a filed feedback item does; the box's sweep then reads the ask among what the master
// is owed (`masters/owed.ts`), named first. The answer comes back the way every fact a session is
// told does (`speaker-link.ts:tellLinked`, `owner-ask.ts`): a core `message_in` in the asking thread,
// handed to the room's session by `deliverWaiting`, which answers the person itself. Each ask keeps
// when it was asked and answered, and one past `SUPPORT_MASTER_ASK_BOUND_MINUTES` reads as a breach.

import {
  SUPPORT_MASTER_ASK_BOUND_MINUTES,
  type SupportAskMasterRequest,
} from '@forge/contracts/support-master-ask';
import { and, asc, desc, eq, gte, isNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportRooms } from '../db/schema-support.js';
import { supportMasterAsks } from '../db/schema-support-asks.js';
import { emitEvent } from '../outbox/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { deliverWaiting } from './dispatch.js';
import { namedProject } from './ops-scope.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { insertAction, type RoomRow, roomById } from './store.js';

const BOUND_MS = SUPPORT_MASTER_ASK_BOUND_MINUTES * 60_000;

/** One ask as a master or the asking room reads it: how long it waited, and whether past the bound. */
export interface MasterAskView {
  id: string;
  project: string;
  rid: string;
  thread: string;
  question: string;
  askedAt: string;
  answer: string | null;
  answeredAt: string | null;
  /** From the ask to its answer, or to now while it waits. */
  waitedMs: number;
  /** Waited past `SUPPORT_MASTER_ASK_BOUND_MINUTES`. */
  breached: boolean;
  boundMinutes: number;
}

type AskRow = typeof supportMasterAsks.$inferSelect;

function viewOf(row: AskRow, rid: string, project: string, now: Date): MasterAskView {
  const waitedMs = (row.answeredAt ?? now).getTime() - row.askedAt.getTime();
  return {
    id: row.id,
    project,
    rid,
    thread: row.thread,
    question: row.question,
    askedAt: row.askedAt.toISOString(),
    answer: row.answer,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    waitedMs,
    breached: waitedMs > BOUND_MS,
    boundMinutes: SUPPORT_MASTER_ASK_BOUND_MINUTES,
  };
}

/**
 * The session asks the master of its home project, or of a project it follows, in the thread it is
 * answering. Recorded, the master woken at once, and nothing posted: the answer is handed back into
 * this thread. A project the room does not reach is refused by name (`OPS_OUT_OF_SCOPE`).
 */
export async function askMaster(
  room: RoomRow,
  input: SupportAskMasterRequest,
  turn: string | null | undefined,
): Promise<Outcome<{ asked: true; ask: string; project: string; next: string }>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const project = await namedProject(room, input.project);
  if (!project.ok) return project;
  const asked = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(supportMasterAsks)
      .values({
        roomId: room.id,
        thread: input.thread,
        projectId: project.value.id,
        sessionId: room.sessionId,
        turnId: turn ?? null,
        question: input.question,
      })
      .returning();
    if (!row) throw new Error('support: an ask of a master was not recorded');
    await emitEvent(tx, 'support.masterAsked', {
      askId: row.id,
      projectId: project.value.id,
      roomId: room.id,
      thread: input.thread,
    });
    return row;
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'operation',
    actorKind: 'session',
    tool: 'ask_master',
    input: { question: input.question, project: project.value.slug },
    output: { ask: asked.id },
  });
  return {
    ok: true,
    value: {
      asked: true,
      ask: asked.id,
      project: project.value.slug,
      next: `Nothing was posted. The ${project.value.slug} master is woken now and answers this before its other work; its answer is handed to you in this thread as a message from forge, and you answer the person yourself then. Meanwhile answer what you can from the record; for an act you handed on, tell the thread in one line that it is in hand, never that it was passed on to a team.`,
    },
  };
}

/** The asks put to `projectId`'s master: those still waiting, or every one of the last week. */
export async function masterAsksOf(
  projectId: string,
  state: 'open' | 'all',
  now: Date = new Date(),
): Promise<{
  boundMinutes: number;
  asks: MasterAskView[];
  waiting: number;
  breached: number;
}> {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const rows = await db
    .select({ ask: supportMasterAsks, rid: supportRooms.rid })
    .from(supportMasterAsks)
    .innerJoin(supportRooms, eq(supportRooms.id, supportMasterAsks.roomId))
    .where(
      and(
        eq(supportMasterAsks.projectId, projectId),
        state === 'open'
          ? isNull(supportMasterAsks.answeredAt)
          : or(isNull(supportMasterAsks.answeredAt), gte(supportMasterAsks.askedAt, weekAgo)),
      ),
    )
    .orderBy(state === 'open' ? asc(supportMasterAsks.askedAt) : desc(supportMasterAsks.askedAt))
    .limit(200);
  const asks = rows.map((r) => viewOf(r.ask, r.rid, projectId, now));
  return {
    boundMinutes: SUPPORT_MASTER_ASK_BOUND_MINUTES,
    asks,
    waiting: asks.filter((a) => a.answeredAt === null).length,
    breached: asks.filter((a) => a.breached).length,
  };
}

/** The asks a thread put to any master, oldest first: what the agent already asked and was told. */
export async function asksOfThread(room: RoomRow, thread: string): Promise<MasterAskView[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(supportMasterAsks)
    .where(and(eq(supportMasterAsks.roomId, room.id), eq(supportMasterAsks.thread, thread)))
    .orderBy(asc(supportMasterAsks.askedAt));
  return rows.map((r) => viewOf(r, room.rid, r.projectId, now));
}

/**
 * The master answers an ask put to its project's master: recorded with who and when, and handed into
 * the asking thread for the room's session, which tells the person itself. Nothing is posted. An ask
 * of another project, or one already answered, is refused by name.
 */
export async function answerMasterAsk(
  actor: { userId: string; projectId: string },
  askId: string,
  answer: string,
): Promise<Outcome<MasterAskView>> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(actor.projectId));
  const [row] = await db
    .select()
    .from(supportMasterAsks)
    .where(and(eq(supportMasterAsks.id, askId), eq(supportMasterAsks.projectId, actor.projectId)))
    .limit(1);
  if (!row) {
    return no(
      'SUPPORT_MASTER_ASK_UNKNOWN',
      '/askId',
      `no room agent asked this project's master ${askId}; GET /api/projects/${actor.projectId}/support/master-asks lists the asks waiting on you. Nothing was handed on`,
    );
  }
  const [answered] = await db
    .update(supportMasterAsks)
    .set({ answer, answeredAt: new Date(), answeredBy: actor.userId })
    .where(and(eq(supportMasterAsks.id, askId), isNull(supportMasterAsks.answeredAt)))
    .returning();
  if (!answered) {
    return no(
      'SUPPORT_MASTER_ASK_ANSWERED',
      '/askId',
      `ask ${askId} was already answered at ${row.answeredAt?.toISOString()}; the room's session has that answer. Nothing was handed on`,
    );
  }
  const room = await roomById(answered.roomId);
  if (!room) throw new Error(`support: the room of ask ${askId} is gone`);
  const waited = viewOf(answered, room.rid, actor.projectId, new Date());
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: await knownThread(room, answered.thread),
    thread: answered.thread,
    kind: 'message_in',
    actorKind: 'core',
    input: {
      note: `The master answered your ask (${answered.question}): ${answer}. Answer the person in this thread yourself now, in your own words, with what this settles.`,
      ask: answered.id,
    },
    externalId: `master-ask:${answered.id}`,
  });
  await deliverWaiting(room.id);
  return { ok: true, value: waited };
}
