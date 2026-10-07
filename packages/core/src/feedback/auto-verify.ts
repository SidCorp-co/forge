/**
 * Forge verifies a resolved item nobody confirmed (owner, 2026-10-07: "anyone may confirm, log it,
 * and if nobody does after a while it confirms itself"). A sweep reads which triaged items read
 * resolved: the first sight dates it (`resolved_seen_at`), and once the project's verify window
 * (`feedback.verifyWindowDays`) has run from that date the item is verified by the system, recorded
 * as such, and its reporter told once. An item that stops reading resolved loses its date, so a
 * reopen or a re-route starts the count again; a reporter who says "not fixed" reopens it as before.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { logger } from '../lib/logger.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';
import { linkedOf, phaseIn } from './list-read.js';
import { type Row, rowIn } from './read.js';
import { autoVerifiedNotice } from './reporter-notices.js';
import { reportersOf, withBell } from './reporters.js';
import { decide, inTx, lockFeedback } from './service.js';
import { autoVerifyAt, verifyWindowDays } from './verify-window.js';

export interface AutoVerifySweepResult {
  dated: number;
  cleared: number;
  verified: number;
}

async function verifyIn(rowId: string, projectId: string, days: number): Promise<boolean> {
  let verified = false;
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, rowId, true);
    if (row.status !== 'triaged') return null;
    const linked = await linkedOf(projectId, [row]);
    if (phaseIn(row, linked) !== 'resolved') return null;
    const reason = `Verified automatically after ${days} days with no reply`;
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
    if (told.length > 0) {
      await emitEvent(tx, 'feedback.reporterTold', {
        projectId,
        feedbackId: row.id,
        kind: 'verified',
        recipients: told,
        ...autoVerifiedNotice(key, row.title, days),
      });
    }
    verified = true;
    return null;
  });
  if (refusals) throw new Error(`feedback auto-verify refused ${rowId}: ${refusals[0]?.detail}`);
  return verified;
}

export async function sweepResolvedFeedback(
  now: Date = new Date(),
): Promise<AutoVerifySweepResult> {
  const result: AutoVerifySweepResult = { dated: 0, cleared: 0, verified: 0 };
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
