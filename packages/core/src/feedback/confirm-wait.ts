/**
 * The wait on a shipped agent-reported item's confirm (ISS-902, FB-480). Its master is owed that
 * confirm on every pass (REQ-66 BC-8, `owed-verify.ts`), and some fixes are tested only by an event it
 * cannot cause, such as the owner's next message in a room. The wait records why the item waits and
 * until when: the owed line leaves it out until its date passes or the event it names happens
 * (`meetRoomConfirmWaits`), then names it again; the item's reads show it, so a person sees why it is
 * not settled. The agent that reported it sets it, or the master that acts for that agent
 * (`reporter-master.ts`); the verify or reopen it waits for clears it (`service.ts:personalActIn`).
 */

import { feedbackKey } from '@forge/contracts/feedback';
import type { FeedbackConfirmWaitView } from '@forge/contracts/feedback';
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import type { Refusal } from '../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { phaseOfRow } from './list-read.js';
import { reportedFromSql } from './owed-verify.js';
import { type ConfirmWaitRequest, confirmWaitOf, confirmWaitRefusal } from './confirm-wait-facts.js';
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
    await tx
      .update(feedback)
      .set({
        confirmWaitUntil: wait.until,
        confirmWaitOn: wait.on ?? null,
        confirmWaitReason: storedText(level, (wait.reason ?? '').trim()).text,
        confirmWaitSetAt: now,
        confirmWaitSetBy: actor.userId,
        confirmWaitMetAt: null,
        updatedAt: now,
      })
      .where(eq(feedback.id, row.id));
    return null;
  });
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
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
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

/**
 * A member's message arrived in a support room of `projectId` (`support/inbound.ts`): every wait on
 * the next room message of an item an agent of that project reported is met, so its confirm is owed
 * again on the master's next pass. Written in the message's own transaction.
 */
export async function meetRoomConfirmWaits(tx: Tx, projectId: string, at: Date): Promise<number> {
  const met = await tx
    .update(feedback)
    .set({ confirmWaitMetAt: at })
    .where(
      and(
        eq(feedback.confirmWaitOn, 'room_message'),
        isNull(feedback.confirmWaitMetAt),
        gt(feedback.confirmWaitUntil, at),
        lt(feedback.confirmWaitSetAt, at),
        eq(feedback.reporterAgency, 'agent'),
        sql`${reportedFromSql} = ${projectId}`,
      ),
    )
    .returning({ id: feedback.id });
  return met.length;
}

/** The wait still holding on each of `ids`, for a door that reads items by summary (the Forge door). */
export async function confirmWaitsOf(
  ids: readonly string[],
  withhold: boolean,
  now: Date = new Date(),
): Promise<Map<string, FeedbackConfirmWaitView | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: feedback.id,
      confirmWaitUntil: feedback.confirmWaitUntil,
      confirmWaitOn: feedback.confirmWaitOn,
      confirmWaitReason: feedback.confirmWaitReason,
      confirmWaitSetAt: feedback.confirmWaitSetAt,
      confirmWaitSetBy: feedback.confirmWaitSetBy,
      confirmWaitMetAt: feedback.confirmWaitMetAt,
    })
    .from(feedback)
    .where(inArray(feedback.id, [...ids]));
  return new Map(rows.map((r) => [r.id, confirmWaitOf(r, now, withhold)]));
}
