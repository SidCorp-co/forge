// Every act on a box goes through core (ISS-1276, ADR 0015), because no tool holds a lock between an
// agent and a person (measured: agent-browser ran the agent's commands at 13–158 ms while a person
// clicked). An agent's command is classed read or write by its verb (`BOX_READ_VERBS`, failing
// closed), refused `BOX_HELD_BY_PERSON` while a person holds the box if it writes, and otherwise
// sent to the device as `box.act`; the device's `act` report completes it. A person's input is
// recorded in the same feed, so the agent reads what the person did when the box is handed back.

import type { BoxControlFrames, BoxInput } from '@forge/contracts/box-wire';
import { actKindOf, BOX_LIMITS, type BoxActRecord } from '@forge/contracts/boxes';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type BoxRow, boxActs, boxes } from '../db/schema-boxes.js';
import { lockXact } from '../lib/advisory-lock.js';
import { accessFor, type BoxActor, pushBox, refuse, tellChanged } from './access.js';
import { boxesPorts } from './ports.js';
import { actById, actRecord, personName } from './read.js';
import { actFault } from './rules.js';
import { rowOf } from './service.js';

/** Acts waiting on their result in this process, woken by the device's report. */
const waiting = new Map<string, () => void>();

/** What an agent learns with its act: the act, and what a person did since its last one. */
export interface AgentActAnswer {
  act: BoxActRecord;
  /** Present where a person acted on the box since this agent's previous act (a hand-back). */
  personActed?: { inputs: number; feed: string };
}

export async function lockedRow(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  id: string,
) {
  await lockXact(tx, 'boxes', `acts:${id}`);
  const [row] = await tx.select().from(boxes).where(eq(boxes.id, id)).for('update').limit(1);
  if (!row) throw refuse('BOX_NOT_FOUND', `no box ${id}`);
  return row;
}

/** What a person did between the agent's previous act and this one. */
async function personSince(boxId: string, seq: number): Promise<AgentActAnswer['personActed']> {
  const [lastAgent] = await db
    .select({ seq: boxActs.seq })
    .from(boxActs)
    .where(and(eq(boxActs.boxId, boxId), eq(boxActs.by, 'agent'), lt(boxActs.seq, seq)))
    .orderBy(desc(boxActs.seq))
    .limit(1);
  const after = lastAgent?.seq ?? 0;
  const inputs = await db
    .select({ seq: boxActs.seq })
    .from(boxActs)
    .where(
      and(
        eq(boxActs.boxId, boxId),
        eq(boxActs.by, 'person'),
        gt(boxActs.seq, after),
        lt(boxActs.seq, seq),
      ),
    );
  if (inputs.length === 0) return undefined;
  return { inputs: inputs.length, feed: `/api/boxes/${boxId}/acts?by=person&after=${after}` };
}

/**
 * What a recorded command shows in place of a session value (ISS-1386): an act whose recorded
 * command holds it keeps no output either, so a cookie or token core placed in a box's browser is
 * in no feed, row or answer.
 */
export const SESSION_SHOWN = '[session]';

/**
 * An agent's command on a box. A refused act is recorded in the feed and changes nothing on the
 * box. A sent one is answered with its result once the device reports it, or `pending` after
 * `actWaitSeconds`, readable later in the feed. `shown` is the command as the feed records it, where
 * it differs from what the device runs: core's own act placing a session, with each value
 * `SESSION_SHOWN`. Such an act is handed to the box's open socket once its row commits, never as an
 * outbox event (ISS-1386): an event row and its queue jobs keep the frame's data until pruned, and a
 * session value rests in no stored row. No socket open to take it fails the act at once, naming why.
 */
export async function agentAct(
  actor: BoxActor,
  boxId: string,
  command: string[],
  runId?: string,
  shown?: string[],
): Promise<AgentActAnswer> {
  const first = await rowOf(boxId);
  if (first.projectId === null) throw refuse('BOX_NOT_FOUND', `no box ${boxId} is any project's`);
  await accessFor(first.projectId, actor, 'project.write', 'act on a box');
  const kind = actKindOf(first.mode, command);
  const holder = first.heldBy ? ((await personName(first.heldBy)) ?? first.heldBy) : null;
  const actorKey = `agent:${runId ?? first.runId ?? 'unnamed'}`;
  const unwritten = shown !== undefined && JSON.stringify(shown) !== JSON.stringify(command);

  const written = await db.transaction(async (tx) => {
    const row = await lockedRow(tx, boxId);
    const fault = actFault(
      row.state,
      kind,
      row.state === 'person' && row.heldSince
        ? { name: holder ?? row.heldBy ?? 'a person', since: row.heldSince }
        : null,
    );
    const seq = row.actSeq + 1;
    await tx.update(boxes).set({ actSeq: seq }).where(eq(boxes.id, row.id));
    const [act] = await tx
      .insert(boxActs)
      .values({
        boxId: row.id,
        seq,
        by: 'agent',
        actor: actorKey,
        actorUserId: actor.userId,
        kind,
        via: 'act',
        command: shown ?? command,
        state: fault ? 'refused' : 'pending',
        refusal: fault?.code ?? null,
        doneAt: fault ? new Date() : null,
      })
      .returning();
    if (!act) throw new Error('box_acts: insert returned no row');
    const frame: BoxControlFrames['box.act'] = { boxId: row.id, actId: act.id, command, kind };
    if (!fault && !unwritten) await pushBox(tx, row.deviceId, 'box.act', frame);
    await tellChanged(tx, { ...row, actSeq: seq });
    return { act, fault, deviceId: row.deviceId, frame };
  });
  if (written.fault) throw refuse(written.fault.code, written.fault.detail);
  if (unwritten) await handOverNow(written.deviceId, written.frame);

  const done = await settled(written.act.id);
  return {
    act: actRecord(done ?? written.act),
    ...(await personSince(boxId, written.act.seq).then((p) => (p ? { personActed: p } : {}))),
  };
}

/**
 * A frame that may not be written down goes to the box's open sockets now. Where none takes it, the
 * act fails at once: it is never queued for a reconnect, since a queue is a stored row.
 */
async function handOverNow(deviceId: string, frame: BoxControlFrames['box.act']): Promise<void> {
  if (boxesPorts().sendToBoxNow(deviceId, { event: 'box.act', data: frame }) > 0) return;
  await db
    .update(boxActs)
    .set({
      state: 'failed',
      stderr:
        "no socket of the box's device was open to take it; an act carrying a session is handed over live, never queued",
      doneAt: new Date(),
    })
    .where(and(eq(boxActs.id, frame.actId), eq(boxActs.state, 'pending')));
}

/** The act once the device reported it, or null when it did not within `actWaitSeconds`. */
async function settled(actId: string) {
  const deadline = Date.now() + BOX_LIMITS.actWaitSeconds * 1000;
  for (;;) {
    const row = await actById(actId);
    if (row && row.state !== 'pending') return row;
    const left = deadline - Date.now();
    if (left <= 0) return row;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(left, 1000));
      waiting.set(actId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    waiting.delete(actId);
  }
}

/** The device's `act` report completes the act and wakes its caller; a session act keeps no output. */
export async function completeAct(
  row: BoxRow,
  report: { actId: string; exitCode: number; stdout: string; stderr: string; durationMs: number },
): Promise<void> {
  const quiet = sql`${boxActs.command} @> ${JSON.stringify([SESSION_SHOWN])}::jsonb`;
  await db
    .update(boxActs)
    .set({
      state: report.exitCode === 0 ? 'done' : 'failed',
      exitCode: report.exitCode,
      stdout: sql`case when ${quiet} then null else ${report.stdout}::text end`,
      stderr: sql`case when ${quiet} then null else ${report.stderr}::text end`,
      durationMs: report.durationMs,
      doneAt: new Date(),
    })
    .where(
      and(eq(boxActs.id, report.actId), eq(boxActs.boxId, row.id), eq(boxActs.state, 'pending')),
    );
  waiting.get(report.actId)?.();
}

/** Whether `input` is worth a line in the feed: a pointer's moves are forwarded, not recorded. */
const recorded = (input: BoxInput) => !(input.t === 'pointer' && input.action === 'move');

/**
 * A person's input, on its way to the box: admitted only while that person holds it, recorded in the
 * feed, and kept as the hold's last sign of life. False where the hold is over: the socket closes.
 */
export async function recordPersonInput(
  boxId: string,
  userId: string,
  input: BoxInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await lockedRow(tx, boxId);
    if (row.state !== 'person' || row.heldBy !== userId) return false;
    const now = new Date();
    if (!recorded(input)) {
      await tx.update(boxes).set({ lastInputAt: now }).where(eq(boxes.id, row.id));
      return true;
    }
    const seq = row.actSeq + 1;
    await tx.update(boxes).set({ actSeq: seq, lastInputAt: now }).where(eq(boxes.id, row.id));
    await tx.insert(boxActs).values({
      boxId: row.id,
      seq,
      by: 'person',
      actor: `person:${userId}`,
      actorUserId: userId,
      kind: 'input',
      via: 'input',
      command: [JSON.stringify(input)],
      state: 'done',
      doneAt: now,
    });
    await tellChanged(tx, { ...row, actSeq: seq });
    return true;
  });
}
