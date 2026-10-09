/**
 * Forge verifies a resolved item nobody confirmed (owner, 2026-10-07: "anyone may confirm, log it,
 * and if nobody does after a while it confirms itself"). A sweep reads which triaged items read
 * resolved: the first sight dates it (`resolved_seen_at`), and once the project's verify window
 * (`feedback.verifyWindowDays`) has run from that date the item is verified by the system, recorded
 * as such, and its reporter told once. An item that stops reading resolved loses its date, so a
 * reopen or a re-route starts the count again; a reporter who says "not fixed" reopens it as before.
 *
 * A word said ahead comes first (REQ-41 BC-20): where the reporter, or a member for them, confirmed
 * the fix in its preview, and the change that shipped is the one they confirmed, that word is the
 * item's loop close the moment it reads resolved — Fixed verifies it, Not fixed reopens it with
 * their note — as them, under the same rules their own press would meet. Anything else asks again.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { type FixConfirmation, loopCloseFromConfirm } from '@forge/contracts/reproduce';
import { say, sayEn } from '@forge/contracts/said';
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
import { type FeedbackActor, type Row, rowIn } from './read.js';
import { tellReporters } from './reporter-language.js';
import { autoVerifiedNotice } from './reporter-notices.js';
import { reportersOf, withBell } from './reporters.js';
import { personalActRefusal, reopenRefusal, verifyRefusal } from './rules.js';
import { decide, feedbackKernelActor, inTx, lockFeedback, roleFacts } from './service.js';
import { autoVerifyAt, verifyWindowDays } from './verify-window.js';

export interface AutoVerifySweepResult {
  dated: number;
  cleared: number;
  /** Every item verified this sweep: past its window, or by a confirm on what shipped. */
  verified: number;
  /** Of those, verified by the reporter's confirm made in the fix's preview. */
  confirmed: number;
  /** Reopened by a Not fixed said in the preview of the change that shipped. */
  reopened: number;
}

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
    moved = act;
    return null;
  });
  if (refusals) throw new Error(`feedback confirm close refused ${row.id}: ${refusals[0]?.detail}`);
  return moved;
}

async function verifyIn(rowId: string, projectId: string, days: number): Promise<boolean> {
  let verified = false;
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, rowId, true);
    if (row.status !== 'triaged') return null;
    const linked = await linkedOf(projectId, [row]);
    if (phaseIn(row, linked) !== 'resolved') return null;
    const reason = sayEn(say('feedback.notice.autoVerified', { n: days }));
    movedRow(
      await transition(tx, FEEDBACK_MACHINE, {
        to: 'verified',
        expect: row.status,
        set: { updatedAt: new Date() },
        where: eq(feedback.id, row.id),
        reason,
        actor: { type: 'system' },
        source: 'feedback-auto-verify',
        returning: ['id'],
      }),
    );
    await decide(tx, row, 'system', { decision: 'verified', reason });
    const key = feedbackKey(row.fbSeq);
    await emitEvent(tx, 'feedback.verifySettled', {
      projectId,
      feedbackId: row.id,
      key,
      decision: 'verified',
    });
    const told = withBell(await reportersOf(tx, row)).map((r) => r.id);
    await tellReporters(tx, { projectId, feedbackId: row.id, kind: 'verified' }, told, (language) =>
      autoVerifiedNotice(language, key, row.title, days),
    );
    verified = true;
    return null;
  });
  if (refusals) throw new Error(`feedback auto-verify refused ${rowId}: ${refusals[0]?.detail}`);
  return verified;
}

export async function sweepResolvedFeedback(
  now: Date = new Date(),
): Promise<AutoVerifySweepResult> {
  const result: AutoVerifySweepResult = {
    dated: 0,
    cleared: 0,
    verified: 0,
    confirmed: 0,
    reopened: 0,
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
            .set({ resolvedSeenAt: null })
            .where(and(eq(feedback.id, row.id), eq(feedback.status, 'triaged')));
          result.cleared += 1;
        }
        continue;
      }
      try {
        const closed = await closeByConfirm(row, projectId);
        if (closed === 'verified') {
          result.verified += 1;
          result.confirmed += 1;
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
        await db.update(feedback).set({ resolvedSeenAt: now }).where(eq(feedback.id, row.id));
        result.dated += 1;
        continue;
      }
      if (autoVerifyAt(row.resolvedSeenAt, days).getTime() > now.getTime()) continue;
      try {
        if (await verifyIn(row.id, projectId, days)) result.verified += 1;
      } catch (err) {
        logger.error(
          { err, feedback: row.id },
          'feedback: an item past its verify window was not verified',
        );
      }
    }
  }
  return result;
}
