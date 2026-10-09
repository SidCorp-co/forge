/**
 * Which step change a requirement's author is owed a notice of (REQ-34 BC-21; Requirement lifecycle
 * r15: "the author is told" at each step). The step a person reads is the standing's `state`. The
 * stored status is written by the kernel's moves. The delivery phases (in_delivery, delivered) are a
 * view (Q1), and no move writes them. So a change is told by comparing two things: the step read now,
 * by the one computation the standing reads (`standing-read.ts:standingsOf`), and the step
 * the author was last told of (`requirements.told_step`). The two reads are serialised per
 * requirement. A change is recorded as told only once `tell` has sent the notice: a send that fails rolls
 * the record back, so the next read finds the change again. A requirement never read before (one that
 * predates told_step) records its step and owes nothing: a step it already stood at is not news.
 *
 * Who reads: notify-requirements.ts, on each stored move (`requirement.transitioned`), on a linked
 * issue's move (`issue.transitioned`, which can start or finish a delivery), and on
 * `requirement.delivered`.
 */

import { type RequirementState, requirementKey } from '@forge/contracts/requirements';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';
import { standingsOf } from './standing-read.js';

export interface StepChange {
  projectId: string;
  requirementId: string;
  key: string;
  title: string;
  from: RequirementState;
  to: RequirementState;
  /** The step after `to`, as the standing reads it; null where nothing follows. */
  next: RequirementState | null;
  /** Revision 1's author, who is told; null where an agent wrote it, which no person reads. */
  authorId: string | null;
}

/**
 * Hands `tell` the step change of `requirementId` since its author was last told, and records it as told
 * once `tell` returns. Answers the change told, or null where there was none.
 */
export async function stepChangeOf(
  requirementId: string,
  tell: (change: StepChange) => Promise<void>,
): Promise<StepChange | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`requirement-step:${requirementId}`}))`,
    );
    const [row] = await tx
      .select({
        id: requirements.id,
        projectId: requirements.projectId,
        status: requirements.status,
        currentRevision: requirements.currentRevision,
        ownerId: requirements.ownerId,
        updatedAt: requirements.updatedAt,
        reqSeq: requirements.reqSeq,
        title: requirements.title,
        toldStep: requirements.toldStep,
        authorId: requirementRevisions.authorId,
        authorAgency: requirementRevisions.authorAgency,
      })
      .from(requirements)
      .leftJoin(
        requirementRevisions,
        and(
          eq(requirementRevisions.requirementId, requirements.id),
          eq(requirementRevisions.revision, 1),
        ),
      )
      .where(eq(requirements.id, requirementId))
      .limit(1);
    if (!row) return null;
    const standing = (await standingsOf(row.projectId, [row], null)).get(requirementId);
    if (!standing) {
      throw new Error(
        `requirement-step: the standing of requirement ${requirementId} read no step, so its author cannot be told`,
      );
    }
    const now = standing.state;
    if (row.toldStep === now) return null;
    await tx.update(requirements).set({ toldStep: now }).where(eq(requirements.id, requirementId));
    if (row.toldStep === null) return null;
    const change: StepChange = {
      projectId: row.projectId,
      requirementId,
      key: requirementKey(row.reqSeq),
      title: row.title,
      from: row.toldStep,
      to: now,
      next: standing.next,
      authorId: row.authorAgency === 'human' ? row.authorId : null,
    };
    await tell(change);
    return change;
  });
}
