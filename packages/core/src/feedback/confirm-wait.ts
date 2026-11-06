/**
 * The wait on a shipped agent-reported item's confirm (ISS-902, FB-480). Its master is owed that
 * confirm on every pass (REQ-66 BC-8, `owed-verify.ts`), and some fixes are tested only by an event it
 * cannot cause, such as the owner's next message in a room. The wait records why the item waits and
 * until when: the owed line leaves it out until its date passes or the event it names happens
 * (`meetRoomConfirmWaits`) or the fix it stands on is reopened (`confirm-wait-read.ts:withdrawnSql`),
 * then names it again; the item's reads show it, so a person sees why it is not settled. The agent that reported it sets it, or the master that acts for that agent
 * (`reporter-master.ts`); the verify or reopen it waits for clears it (`service.ts:personalActIn`).
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type ConfirmWaitMetBy, feedback } from '../db/schema-feedback.js';
import { supportFeedbackLinks, supportRooms } from '../db/schema-support.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import type { Refusal } from '../lib/refusal.js';
import { requireDeclaredOn } from '../permissions/index.js';
import { type ConfirmWaitRequest, confirmWaitRefusal } from './confirm-wait-facts.js';
import { withdrawnSql } from './confirm-wait-read.js';
import { phaseOfRow } from './list-read.js';
import { reportedFromSql } from './owed-verify.js';
import { type FeedbackActor, rowIn } from './read.js';
import { reporterMasterProject } from './reporter-master.js';
import { refusal } from './rules.js';
import { answer, type FeedbackOutcome, inTx, lockFeedback } from './service.js';

/**
 * Sets the wait on item `feedbackId` of `projectId`, replacing any standing one. `notYours` is the
 * door's refusal of a caller that neither reported the item nor acts for its agent reporter.
 */
export async function setConfirmWait(input: {
  projectId: string;
  feedbackId: string;
  actor: FeedbackActor;
  wait: ConfirmWaitRequest;
  notYours: (key: string) => Refusal;
  now?: Date;
}): Promise<Refusal[] | null> {
  const { projectId, actor, wait } = input;
  const now = input.now ?? new Date();
  const master = await reporterMasterProject(input.feedbackId, actor);
  const level = await dataPolicyOf(projectId);
  return inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, input.feedbackId, true);
    const key = feedbackKey(row.fbSeq);
    if (row.reportedBy !== actor.userId && master === null) return [input.notYours(key)];
    const refused = confirmWaitRefusal(
      {
        key,
        phase: await phaseOfRow(projectId, row),
        agentReported: row.reporterAgency === 'agent',
      },
      wait,
      now,
    );
    if (refused) return [refused];
    const room = wait.on === 'room_message' ? await awaitedThread(tx, row.id, key, wait) : null;
    if (room && 'code' in room) return [room];
    await tx
      .update(feedback)
      .set({
        confirmWaitUntil: wait.until,
        confirmWaitOn: wait.on ?? null,
        confirmWaitReason: storedText(level, (wait.reason ?? '').trim()).text,
        confirmWaitSetAt: now,
        confirmWaitSetBy: actor.userId,
        confirmWaitRid: room?.rid ?? null,
        confirmWaitThread: room?.thread ?? null,
        confirmWaitMetAt: null,
        confirmWaitMetBy: null,
        updatedAt: now,
      })
      .where(eq(feedback.id, row.id));
    return null;
  });
}

/**
 * The room thread whose next member message ends a wait on a room message (ISS-1038): the group and
 * thread the wait names, which a room of the project the item was reported from must hold; else the
 * thread the item was recorded from (`support_feedback_links`). Refused by name where it names a group
 * no such room holds, or names none and no room recorded the item: then only its date could end it,
 * which is a wait without `on`.
 */
async function awaitedThread(
  tx: Tx,
  feedbackId: string,
  key: string,
  wait: ConfirmWaitRequest,
): Promise<{ rid: string; thread: string } | Refusal> {
  if (wait.rid && wait.thread) {
    const [held] = await tx
      .select({ id: supportRooms.id })
      .from(supportRooms)
      .where(
        and(
          eq(supportRooms.rid, wait.rid),
          sql`${supportRooms.projectId} = (SELECT ${reportedFromSql} FROM feedback WHERE feedback.id = ${feedbackId})`,
        ),
      )
      .limit(1);
    if (!held) {
      return refusal(
        'FEEDBACK_CONFIRM_WAIT_ROOM',
        '/rid',
        `no room of the project ${key} was reported from answers the group ${wait.rid}, so no message there could end its wait; name a group that project's rooms answer, or leave rid and thread out to wait in the thread ${key} was recorded from.`,
      );
    }
    return { rid: wait.rid, thread: wait.thread };
  }
  const [linked] = await tx
    .select({ rid: supportRooms.rid, thread: supportFeedbackLinks.thread })
    .from(supportFeedbackLinks)
    .innerJoin(supportRooms, eq(supportRooms.id, supportFeedbackLinks.roomId))
    .where(eq(supportFeedbackLinks.feedbackId, feedbackId))
    .limit(1);
  if (linked) return linked;
  return refusal(
    'FEEDBACK_CONFIRM_WAIT_NO_THREAD',
    '/on',
    `${key} was not recorded from a room thread Forge knows, so no room message can be told apart as its own: name the group and thread the message is awaited in (rid, thread), or leave on out and wait on the date alone.`,
  );
}

/** The project door's refusal of a caller that neither reported the item nor acts for its agent reporter. */
const confirmWaitForbidden = (key: string): Refusal =>
  refusal(
    'FEEDBACK_CONFIRM_WAIT_FORBIDDEN',
    '/feedback',
    `only the agent that reported ${key}, or the master of the project it reported it from, sets the wait on its confirm.`,
  );

/** `POST /api/projects/:id/feedback/:fb/confirm-wait`: the project door's wait, answered with the item. */
export async function confirmWaitFeedback(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  wait: ConfirmWaitRequest;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await requireDeclaredOn(projectId, actor.userId, 'project.read');
  const first = await rowIn(db, projectId, input.ref);
  const refusals = await setConfirmWait({
    projectId,
    feedbackId: first.id,
    actor,
    wait: input.wait,
    notYours: confirmWaitForbidden,
  });
  if (refusals) return { ok: false, refusals };
  return answer(projectId, first.id, actor);
}

/** A member's message as it arrived in a room (`support/inbound.ts`), which may end a wait on it. */
export interface RoomMessage {
  /** The project of the room it arrived in. */
  projectId: string;
  rid: string;
  thread: string;
  /** Its id on the chat server. */
  id: string;
  /** Its writer, by username where the server named one. */
  author: string;
  text: string;
  at: Date;
}

/** The most of a message's words an item keeps of the one that ended its wait. */
const MET_TEXT_MAX = 2_000;

/**
 * A member's message arrived in a room of `message.projectId` (`support/inbound.ts`): the wait on a
 * room message of an item an agent of that project reported is met only where it awaits this group
 * and thread (ISS-1038), and the item keeps which message met it, its words stored under the item's
 * project's data policy, so its confirm is owed again on the master's next pass, naming it. A message
 * in another thread or group leaves every other wait standing. Written in the message's own
 * transaction; answers how many waits it met.
 */
export async function meetRoomConfirmWaits(tx: Tx, message: RoomMessage): Promise<number> {
  const { at } = message;
  const waiting = await tx
    .select({ id: feedback.id, projectId: feedback.projectId })
    .from(feedback)
    .where(
      and(
        eq(feedback.confirmWaitOn, 'room_message'),
        eq(feedback.confirmWaitRid, message.rid),
        eq(feedback.confirmWaitThread, message.thread),
        isNull(feedback.confirmWaitMetAt),
        gt(feedback.confirmWaitUntil, at),
        lt(feedback.confirmWaitSetAt, at),
        sql`NOT ${withdrawnSql}`,
        eq(feedback.reporterAgency, 'agent'),
        sql`${reportedFromSql} = ${message.projectId}`,
      ),
    );
  let met = 0;
  for (const w of waiting) {
    const level = await dataPolicyOf(w.projectId);
    const metBy: ConfirmWaitMetBy = {
      message: message.id,
      rid: message.rid,
      thread: message.thread,
      author: message.author,
      at: at.toISOString(),
      text: storedText(level, message.text.slice(0, MET_TEXT_MAX)).text,
    };
    const done = await tx
      .update(feedback)
      .set({ confirmWaitMetAt: at, confirmWaitMetBy: metBy })
      .where(and(eq(feedback.id, w.id), isNull(feedback.confirmWaitMetAt)))
      .returning({ id: feedback.id });
    met += done.length;
  }
  return met;
}
