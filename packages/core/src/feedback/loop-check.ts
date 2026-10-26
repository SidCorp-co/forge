/**
 * Loop check for a resolved item nobody confirmed (Feedback lifecycle r14 loop-check; Feedback triage
 * r16). A sweep reads which triaged items read resolved: the first sight dates it
 * (`resolved_seen_at`). Once the project's verify window (`feedback.verifyWindowDays`) has run from
 * that date, the sweep reads what the record says about "is the problem gone?"
 * (`loop-close.ts:goneByRecord`) and writes it on the item with its time (`verifyHeldAt`,
 * `verifyHeldWhy`), so the item waits on a person, who verifies it (anyone on the project,
 * `project.read`) or reopens it (a holder of feedback.approve) through the item's own verify and
 * reopen, and is never held in silence. Nothing here verifies an
 * item by itself: a record that reads it gone is what that person answers from, not an answer. An
 * item that stops reading resolved loses its date and that note, so a reopen or a re-route starts
 * the count again; a reporter who says "not fixed" reopens it as before.
 *
 * A word said ahead comes first (REQ-41 BC-20): where the reporter, or a member for them, confirmed
 * the fix in its preview, and the change that shipped is the one they confirmed, that word is the
 * item's loop close the moment it reads resolved — Fixed verifies it, Not fixed reopens it with
 * their note — as them, under the same rules their own press would meet. Anything else asks again.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { type FixConfirmation, loopCloseFromConfirm } from '@forge/contracts/reproduce';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { issueDisplayIds } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';
import { fixConfirmationsOf } from '../previews/index.js';
import { agencyOf, issueOfPreview, shippedPatchOf } from './confirm-reads.js';
import { linkedOf, phaseIn } from './list-read.js';
import { goneByRecord, loopCloseFactsOf } from './loop-close.js';
import { type FeedbackActor, type Row, rowIn } from './read.js';
import { tellStepToReporters } from './reporters.js';
import { personalActRefusal, reopenRefusal, verifyRefusal } from './rules.js';
import { decide, feedbackKernelActor, inTx, lockFeedback, roleFacts } from './service.js';
import { recordCheckAt, verifyWindowDays } from './verify-window.js';

export interface AutoVerifySweepResult {
  dated: number;
  cleared: number;
  /** Verified this sweep by the reporter's confirm made in the fix's preview: their word, carried out. */
  verified: number;
  /** Reopened by a Not fixed said in the preview of the change that shipped. */
  reopened: number;
  /** Past their window, left resolved for a holder of feedback.approve with what the record reads. */
  held: number;
  /** Of those, the ones whose reason was written on the item this sweep (new, or changed since). */
  noted: number;
}

const NOT_HELD = { verifyHeldAt: null, verifyHeldWhy: null } as const;

/** The latest confirm, when the change that shipped is the one it was said of; null asks as today. */
async function confirmedClose(row: Row): Promise<{
  close: 'gone' | 'not_gone';
  confirm: FixConfirmation;
  issueKey: string;
} | null> {
  const confirms = await fixConfirmationsOf(row.id);
  const latest = confirms[0];
  if (!latest) return null;
  const issue = await issueOfPreview(latest.previewId);
  if (!issue) return null;
  const close = loopCloseFromConfirm(confirms, await shippedPatchOf(issue));
  if (!close) return null;
  const issueKey = (await issueDisplayIds([issue.issueId])).get(issue.issueId) ?? issue.issueId;
  return { close, confirm: latest, issueKey };
}

/**
 * The confirm closes the loop as the person who said it: their verify or reopen, held to the rules
 * their own press is (`personalActRefusal`, then the phase), so a confirm by someone who may no
 * longer say it, or on an item that no longer reads resolved, closes nothing and the item asks again.
 */
async function closeByConfirm(
  row: Row,
  projectId: string,
): Promise<'verified' | 'reopened' | null> {
  const found = await confirmedClose(row);
  if (!found) return null;
  const { close, confirm, issueKey } = found;
  const act = close === 'gone' ? 'verified' : 'reopened';
  const actor: FeedbackActor = { userId: confirm.by, agency: await agencyOf(confirm.by) };
  const byReporter = confirm.by === row.reportedBy;
  const forbidden = personalActRefusal(await roleFacts(actor, projectId), act, byReporter);
  if (forbidden) {
    logger.warn(
      { feedback: row.id, confirm: confirm.previewId, refusal: forbidden.code },
      'feedback: a confirm made in a fix preview no longer counts; the item asks again',
    );
    return null;
  }
  const said = `in the preview of ${issueKey} (patch ${confirm.patchId.slice(0, 12)}) on ${confirm.at.slice(0, 10)}, and that change shipped`;
  const reason =
    act === 'verified'
      ? [`Confirmed fixed ${said}`, byReporter ? null : 'on behalf of the reporter']
          .filter(Boolean)
          .join(' · ')
      : `${confirm.note ?? ''} (said not fixed ${said})`.trim();
  let moved: 'verified' | 'reopened' | null = null;
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const now = await rowIn(tx, projectId, row.id, true);
    if (now.status !== 'triaged') return null;
    const phase = phaseIn(now, await linkedOf(projectId, [now]));
    const refused =
      act === 'verified' ? verifyRefusal(phase) : reopenRefusal(phase, confirm.note ?? undefined);
    if (refused) return null;
    movedRow(
      await transition(tx, FEEDBACK_MACHINE, {
        to: act,
        expect: now.status,
        set: { resolvedSeenAt: null, updatedAt: new Date() },
        where: eq(feedback.id, now.id),
        reason,
        actor: feedbackKernelActor(actor),
        source: 'feedback-fix-confirm',
        returning: ['id'],
      }),
    );
    await decide(tx, now, actor, { decision: act, reason });
    await emitEvent(tx, 'feedback.verifySettled', {
      projectId,
      feedbackId: now.id,
      key: feedbackKey(now.fbSeq),
      decision: act,
    });
    await tellStepToReporters(tx, now, act, confirm.by);
    moved = act;
    return null;
  });
  if (refusals) throw new Error(`feedback confirm close refused ${row.id}: ${refusals[0]?.detail}`);
  return moved;
}

/**
 * Writes on the item what the record reads for the person who answers it, once per reading: a sweep
 * that finds the same reading again writes nothing, and one that finds another writes it with its
 * own time.
 */
async function noteHeld(row: Row, why: string, now: Date): Promise<boolean> {
  const current =
    row.verifyHeldAt !== null &&
    row.resolvedSeenAt !== null &&
    row.verifyHeldAt.getTime() >= row.resolvedSeenAt.getTime() &&
    row.verifyHeldWhy === why;
  if (current) return false;
  const written = await db
    .update(feedback)
    .set({ verifyHeldAt: now, verifyHeldWhy: why })
    .where(and(eq(feedback.id, row.id), eq(feedback.status, 'triaged')))
    .returning({ id: feedback.id });
  if (written.length > 0) {
    logger.info(
      { feedback: row.id, why },
      'feedback: past its verify window; what the record reads is written for a person to answer',
    );
  }
  return written.length > 0;
}

export async function sweepResolvedFeedback(
  now: Date = new Date(),
): Promise<AutoVerifySweepResult> {
  const result: AutoVerifySweepResult = {
    dated: 0,
    cleared: 0,
    verified: 0,
    reopened: 0,
    held: 0,
    noted: 0,
  };
  const open = await db.select().from(feedback).where(eq(feedback.status, 'triaged'));
  const byProject = new Map<string, Row[]>();
  for (const r of open) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
  for (const [projectId, rows] of byProject) {
    const linked = await linkedOf(projectId, rows);
    const days = await verifyWindowDays(projectId);
    for (const row of rows) {
      const resolved = phaseIn(row, linked) === 'resolved';
      if (!resolved) {
        if (row.resolvedSeenAt) {
          await db
            .update(feedback)
            .set({ resolvedSeenAt: null, ...NOT_HELD })
            .where(and(eq(feedback.id, row.id), eq(feedback.status, 'triaged')));
          result.cleared += 1;
        }
        continue;
      }
      try {
        const closed = await closeByConfirm(row, projectId);
        if (closed === 'verified') {
          result.verified += 1;
          continue;
        }
        if (closed === 'reopened') {
          result.reopened += 1;
          continue;
        }
      } catch (err) {
        logger.error(
          { err, feedback: row.id },
          'feedback: a confirm made in a fix preview was not read as its loop close',
        );
      }
      if (!row.resolvedSeenAt) {
        await db
          .update(feedback)
          .set({ resolvedSeenAt: now, ...NOT_HELD })
          .where(eq(feedback.id, row.id));
        result.dated += 1;
        continue;
      }
      if (recordCheckAt(row.resolvedSeenAt, days).getTime() > now.getTime()) continue;
      try {
        const record = goneByRecord(
          await loopCloseFactsOf({ ...row, resolvedSeenAt: row.resolvedSeenAt }),
        );
        result.held += 1;
        if (await noteHeld(row, record.why, now)) result.noted += 1;
      } catch (err) {
        logger.error(
          { err, feedback: row.id },
          'feedback: what the record reads of an item past its verify window was not written',
        );
      }
    }
  }
  return result;
}
