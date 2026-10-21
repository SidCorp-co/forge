/**
 * Corrections (REQ-50 BC-1): each return, rejection or failing verdict said with a reason, and each
 * chat reply the classifier kept, as one row linked to the item it corrects. A source records its
 * correction in the transaction of the act itself, so a correction exists exactly when its act does;
 * the unique `(source, source_ref)` makes a retried delivery a no-op rather than a second row.
 */

import type { CorrectionItemKind, CorrectionSource } from '@forge/contracts/lessons';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { corrections } from '../db/schema-lessons.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { refuse } from './refuse.js';

export interface CorrectionInput {
  projectId: string;
  source: CorrectionSource;
  /** The act's own id (the return, the kernel move, the verdict, the chat message). */
  sourceRef: string;
  item: { kind: CorrectionItemKind; id: string; key: string; title?: string | null };
  areaId?: string | null;
  /** As said; a blank reason is no correction, and nothing is written. */
  reason: string | null | undefined;
  by: { userId: string | null; agency: 'human' | 'agent' };
  /** The classifier's confidence; a chat correction carries one and no other source does. */
  score?: number;
  at?: Date;
}

/** Keep one correction; answers its id, or null when it said no reason or was kept before. */
export async function recordCorrection(tx: Tx, input: CorrectionInput): Promise<string | null> {
  const reason = input.reason?.trim();
  if (!reason) return null;
  const [row] = await tx
    .insert(corrections)
    .values({
      projectId: input.projectId,
      source: input.source,
      sourceRef: input.sourceRef,
      itemKind: input.item.kind,
      itemId: input.item.id,
      itemKey: input.item.key,
      itemTitle: input.item.title ?? null,
      areaId: input.areaId ?? null,
      reason,
      byUserId: input.by.userId,
      agency: input.by.agency,
      score: input.score ?? null,
      ...(input.at ? { saidAt: input.at } : {}),
    })
    .onConflictDoNothing({ target: [corrections.source, corrections.sourceRef] })
    .returning({ id: corrections.id });
  return row?.id ?? null;
}

/**
 * The person says a kept correction is not one (a chat reply the classifier misread, say). It never
 * feeds a lesson after that. Its author or a `project.write` holder may say so; one a lesson already
 * learned from is refused, since the lesson is decided on its own page.
 */
export async function dismissCorrection(input: {
  projectId: string;
  correctionId: string;
  userId: string;
}): Promise<void> {
  const [row] = await db
    .select({
      id: corrections.id,
      by: corrections.byUserId,
      lessonId: corrections.lessonId,
      dismissedAt: corrections.dismissedAt,
    })
    .from(corrections)
    .where(and(eq(corrections.projectId, input.projectId), eq(corrections.id, input.correctionId)))
    .limit(1);
  if (!row) {
    throw refuse(
      'CORRECTION_NOT_FOUND',
      `project ${input.projectId} holds no correction ${input.correctionId}`,
      '/correction',
    );
  }
  if (row.by !== input.userId) {
    await requireCan(actorFor(input.userId), 'project.write', projectResource(input.projectId));
  }
  if (row.lessonId) {
    throw refuse(
      'LESSON_DECIDED',
      'a lesson already learned from this correction: reject or retire the lesson on the Lessons page instead',
      '/correction',
    );
  }
  if (row.dismissedAt) return;
  await db
    .update(corrections)
    .set({ dismissedAt: new Date(), dismissedBy: input.userId })
    .where(eq(corrections.id, row.id));
}
