import { and, eq, exists, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback, feedbackAttachments, feedbackDecisions } from '../db/schema-feedback.js';
import { itemEmbeddings } from '../db/schema-item-embeddings.js';
import { getStorage } from '../integrations/index.js';
import { deleteFeedbackEmbedding } from '../knowledge/index.js';
import { logger } from '../lib/logger.js';

/** A declined item keeps its row; its attachments and embedding go this long after the decline. */
export const DECLINED_PURGE_AFTER_DAYS = 180;
const BATCH = 200;

export interface DeclinedFeedbackSweepResult {
  items: number;
  attachments: number;
}

/**
 * feedback-lifecycle `declined`: every item declined more than 180 days ago that still holds an
 * attachment or an embedding loses both. Declined is terminal, so its one declined decision dates it.
 */
export async function sweepDeclinedFeedback(
  now: Date = new Date(),
): Promise<DeclinedFeedbackSweepResult> {
  const before = new Date(now.getTime() - DECLINED_PURGE_AFTER_DAYS * 86_400_000);
  let paths: string[] = [];
  const ids = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: feedback.id })
      .from(feedback)
      .where(
        and(
          eq(feedback.status, 'declined'),
          exists(
            tx
              .select({ one: sql`1` })
              .from(feedbackDecisions)
              .where(
                and(
                  eq(feedbackDecisions.feedbackId, feedback.id),
                  eq(feedbackDecisions.decision, 'declined'),
                  lt(feedbackDecisions.decidedAt, before),
                ),
              ),
          ),
          or(
            exists(
              tx
                .select({ one: sql`1` })
                .from(feedbackAttachments)
                .where(eq(feedbackAttachments.feedbackId, feedback.id)),
            ),
            exists(
              tx
                .select({ one: sql`1` })
                .from(itemEmbeddings)
                .where(eq(itemEmbeddings.feedbackId, feedback.id)),
            ),
          ),
        ),
      )
      .limit(BATCH);
    const ids = due.map((d) => d.id);
    if (ids.length === 0) return ids;
    const gone = await tx
      .delete(feedbackAttachments)
      .where(inArray(feedbackAttachments.feedbackId, ids))
      .returning({ path: feedbackAttachments.storagePath });
    paths = gone.map((g) => g.path);
    for (const id of ids) await deleteFeedbackEmbedding(tx, id);
    return ids;
  });
  const storage = getStorage();
  for (const path of paths) {
    await storage.delete(path).catch((err: unknown) => {
      logger.error(
        { err, path },
        'feedback: a declined item attachment was not removed from storage',
      );
    });
  }
  return { items: ids.length, attachments: paths.length };
}
