/**
 * `item_embeddings` for feedback (Q7): one vector per item, of its stored head text (title and
 * body, already scrubbed on a sensitive project), written after the item is filed through the
 * shared writer, which withholds it on a no_egress project. "Similar feedback" compares the item's
 * own stored vector with its project's, so reading it sends nothing to a provider.
 */

import type { SimilarFeedbackResponse } from '@forge/contracts/feedback';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { feedback } from '../db/schema-feedback.js';
import { itemEmbeddings } from '../db/schema-item-embeddings.js';
import { writeItemEmbedding } from '../embeddings/item-writer.js';
import { assertProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import { type FeedbackActor, feedbackKey, phaseOfRow, rowIn } from './read.js';

/** Embeds the item's text, replacing whatever row it held; a redacted item holds none. */
export async function embedFeedback(feedbackId: string) {
  const [row] = await db.select().from(feedback).where(eq(feedback.id, feedbackId));
  if (!row || row.redactedAt) return null;
  return writeItemEmbedding({
    projectId: row.projectId,
    arc: { feedbackId },
    version: 1,
    text: [row.title, row.body ?? ''].filter((s) => s.trim()).join('\n'),
    what: feedbackKey(row.fbSeq),
  });
}

/** After the write committed: embed, logging what did not land. */
export function embedFeedbackLater(feedbackId: string): void {
  embedFeedback(feedbackId)
    .then((status) => {
      if (status && status !== 'embedded') {
        logger.warn({ feedbackId, status }, 'item_embeddings: the feedback item was not embedded');
      }
    })
    .catch((err: unknown) =>
      logger.error(
        { err, feedbackId },
        'item_embeddings: the feedback embedding row was not written',
      ),
    );
}

export async function similarFeedbackAs(
  viewer: FeedbackActor,
  projectId: string,
  ref: string,
  limit = 5,
): Promise<SimilarFeedbackResponse> {
  await assertProjectAccess(projectId, viewer.userId, 'viewer');
  const row = await rowIn(db, projectId, ref);
  const [own] = await db.select().from(itemEmbeddings).where(eq(itemEmbeddings.feedbackId, row.id));
  if (own?.status !== 'embedded' || !own.embedding || !own.model) {
    const status =
      own?.status === 'provider_not_configured' ? 'provider_not_configured' : 'not_embedded';
    return {
      status,
      message:
        own?.error ??
        `${feedbackKey(row.fbSeq)} has no vector yet, so nothing is compared; it does not mean none is similar.`,
      hits: [],
    };
  }
  const distance = cosineDistance(itemEmbeddings.embedding, own.embedding);
  const rows = await db
    .select({ row: feedback, distance: sql<number>`${distance}` })
    .from(itemEmbeddings)
    .innerJoin(feedback, eq(feedback.id, itemEmbeddings.feedbackId))
    .where(
      and(
        eq(itemEmbeddings.projectId, projectId),
        eq(itemEmbeddings.status, 'embedded'),
        eq(itemEmbeddings.model, own.model),
        ne(feedback.id, row.id),
      ),
    )
    .orderBy(distance)
    .limit(limit);
  return {
    status: 'ok',
    model: own.model,
    hits: await Promise.all(
      rows.map(async (r) => ({
        key: feedbackKey(r.row.fbSeq),
        title: r.row.title,
        phase: await phaseOfRow(projectId, r.row),
        similarity: Math.round((1 - Number(r.distance)) * 1000) / 1000,
      })),
    ),
  };
}
