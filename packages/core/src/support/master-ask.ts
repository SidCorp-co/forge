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
  SUPPORT_LOW_IMPACT_SLUG,
  SUPPORT_MASTER_ASK_BOUND_MINUTES,
  SUPPORT_PRECEDENT_PREFIX,
  type SupportAskMasterRequest,
} from '@forge/contracts/support-master-ask';
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions, supportRooms } from '../db/schema-support.js';
import { supportMasterAsks } from '../db/schema-support-asks.js';
import { markUntrusted } from '../lib/untrusted-text.js';
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
  /** The case's problem as the agent held it when it asked, or null while it did not know it. */
  problem: string | null;
  /** The case's solution as the agent held it when it asked, or null while none was named. */
  solution: string | null;
  /** Which ask of the thread's case this is, from 1: the case is the thread's asks in order. */
  round: number;
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

/** What the agent held of its case when it made an ask: kept on the ask's own act, read back by the ask's id. */
interface CaseNote {
  problem: string | null;
  solution: string | null;
}

/**
 * The case notes of these asks. The case is a thread's asks in order (`support_master_asks`, keyed by
 * room and thread), and what the agent held of it at each ask is on that ask's act record: no table of
 * its own, so a later reader (the agent's notes, a precedent from the owner) attaches to the same
 * room and thread.
 */
async function caseNotesOf(askIds: readonly string[]): Promise<Map<string, CaseNote>> {
  const notes = new Map<string, CaseNote>();
  if (askIds.length === 0) return notes;
  const rows = await db
    .select({ input: supportActions.input, output: supportActions.output })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.tool, 'ask_master'),
        inArray(sql<string>`${supportActions.output}->>'ask'`, [...askIds]),
      ),
    );
  for (const r of rows) {
    const ask = (r.output as { ask?: string } | null)?.ask;
    const input = (r.input ?? {}) as { problem?: unknown; solution?: unknown };
    if (!ask) continue;
    notes.set(ask, {
      problem: typeof input.problem === 'string' ? input.problem : null,
      solution: typeof input.solution === 'string' ? input.solution : null,
    });
  }
  return notes;
}

/**
 * Which ask of its case each of these is, from 1, in the order they were asked. A case is a thread's
 * asks from the latest one the agent opened as new (`opens_case`, its declaration: core guesses no
 * relatedness), so an unrelated need later in a long thread starts again at round 1.
 */
async function roundsOf(askIds: readonly string[]): Promise<Map<string, number>> {
  const rounds = new Map<string, number>();
  if (askIds.length === 0) return rounds;
  const ids = sql.join(
    askIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT id, rn FROM (
      SELECT id, row_number() OVER (PARTITION BY room_id, thread, opened ORDER BY asked_at, id) AS rn
        FROM (
          SELECT id, room_id, thread, asked_at,
                 count(*) FILTER (WHERE opens_case) OVER (PARTITION BY room_id, thread ORDER BY asked_at, id) AS opened
            FROM support_master_asks
           WHERE (room_id, thread) IN (SELECT room_id, thread FROM support_master_asks WHERE id IN (${ids}))
        ) c
    ) t WHERE id IN (${ids})
  `)) as unknown as { id: string; rn: number | string }[];
  for (const r of rows) rounds.set(r.id, Number(r.rn));
  return rounds;
}

/** The views of these ask rows, each with its case note and round. */
async function viewsOf(
  rows: readonly { row: AskRow; rid: string; project: string }[],
  now: Date,
): Promise<MasterAskView[]> {
  const ids = rows.map((r) => r.row.id);
  const [notes, rounds] = await Promise.all([caseNotesOf(ids), roundsOf(ids)]);
  return rows.map((r) =>
    viewOf(r.row, r.rid, r.project, now, notes.get(r.row.id), rounds.get(r.row.id) ?? 1),
  );
}

function viewOf(
  row: AskRow,
  rid: string,
  project: string,
  now: Date,
  note: CaseNote | undefined,
  round: number,
): MasterAskView {
  const waitedMs = (row.answeredAt ?? now).getTime() - row.askedAt.getTime();
  return {
    id: row.id,
    project,
    rid,
    thread: row.thread,
    question: row.question,
    problem: note?.problem ?? null,
    solution: note?.solution ?? null,
    round,
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
): Promise<Outcome<{ asked: true; ask: string; project: string; round: number; next: string }>> {
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
        opensCase: input.newCase === true,
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
  const round = (await roundsOf([asked.id])).get(asked.id) ?? 1;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'operation',
    actorKind: 'session',
    tool: 'ask_master',
    input: {
      question: input.question,
      project: project.value.slug,
      ...(input.newCase ? { newCase: true } : {}),
      ...(input.problem ? { problem: input.problem } : {}),
      ...(input.solution ? { solution: input.solution } : {}),
    },
    output: { ask: asked.id },
  });
  return {
    ok: true,
    value: {
      asked: true,
      ask: asked.id,
      project: project.value.slug,
      round,
      next: `Nothing was posted. This is round ${round} of this case${round === 1 ? '' : ' (a different need of theirs is a new case: ask with newCase: true)'}. The ${project.value.slug} master is woken now and answers this before its other work; its answer is handed to you in this thread as a note from forge. It is what you learn of the case, not yet the reply: when it comes, weigh it, and ask again with the problem and the solution as you hold them until both are named; only then tell the person, once, as ONE message in your own voice. Meanwhile react to the asker's message with support.react and post nothing. Never say a master, a team or another side has it.`,
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
  const asks = await viewsOf(
    rows.map((r) => ({ row: r.ask, rid: r.rid, project: projectId })),
    now,
  );
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
  return viewsOf(
    rows.map((r) => ({ row: r, rid: room.rid, project: r.projectId })),
    now,
  );
}

/**
 * The note a master's answer is handed to the room's session as. Owner, 2026-11-28 (ISS-1483): the
 * person knows one voice, the room's agent, which owns the case and works it with the master until
 * the problem and a solution are both named; the answer is what it learns on the way, never a reply
 * to relay. What the master checked is the case's own fact, said with when and never with who:
 * "he reports it, say it as his" had the agent name the master and "his side" (AdminHub, 26/11 and
 * 28/11). FB-824's transcripts (ISS-1416) stay held: a state is said from a check made this turn
 * (the master's counts, handed in this turn), dated, and an act is told from its result. The ask
 * and the answer each stand in an untrusted frame, core's teaching alone outside (ISS-1425).
 */
export function masterAnsweredNote(question: string, answer: string): string {
  // the ask and the answer are words, never core's: either may quote a member (ISS-1425)
  return `The master answered your ask.\n${markUntrusted(question, { source: 'your ask of the master' })}\n${markUntrusted(answer, { source: 'the master answer' })}\nThis is what you now know of the case, not yet a reply. Hold it against what the person asked: does the case now name the problem and a solution that answers THEIR question? Where it does not, work on: read what your own acts reach, then ask again with support.ask_master, carrying the problem and the solution as you hold them and what this answer left open; where only the person holds the missing fact, ask them that one thing yourself. When both are named, tell the person in this thread yourself, in your own words and in the language they write, to them in the second person: what the problem was, what is done or comes next, what they must do. You are the one voice they know: say what the check showed and when ("at 02:05 the flag was off"), as what you checked, never that a master, a team, a project's side or anyone else told you, looked or is working on it, and never what the master wrote as it is written, nor a question or an instruction he wrote for you to put to them. What you already told them in this thread stands: say only what this adds or changes, never your earlier reply again in other words; where it adds nothing, stay silent with support.silent. Where the owner agreed a case like this one, it is a precedent (support.search, slugs starting ${SUPPORT_PRECEDENT_PREFIX}): apply it and ask no one again; a case outside [knowledge:${SUPPORT_LOW_IMPACT_SLUG}] is not for you and the master to settle alone, and goes to the owner with support.ask_owner as options and your recommendation. Where they already ruled on it, make the act as them and tell it from the act's result: done once it answered, and a refused act was not made; never ask them again.`;
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
  const [waited] = await viewsOf(
    [{ row: answered, rid: room.rid, project: actor.projectId }],
    new Date(),
  );
  if (!waited) throw new Error(`support: ask ${askId} has no view`);
  // its `ask` marks it a master's answer: a turn that completes with it ends its hand-over, posted
  // or not, and it is never handed again (ISS-1301, `turn-retry.ts:isMasterAnswer`)
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: await knownThread(room, answered.thread),
    thread: answered.thread,
    kind: 'message_in',
    actorKind: 'core',
    input: {
      note: masterAnsweredNote(answered.question, answer),
      ask: answered.id,
    },
    externalId: `master-ask:${answered.id}`,
  });
  await deliverWaiting(room.id);
  return { ok: true, value: waited };
}
