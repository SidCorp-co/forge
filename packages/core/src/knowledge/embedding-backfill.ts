import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries } from '../db/schema.js';
import { itemEmbeddings } from '../db/schema-item-embeddings.js';
import {
  EmbeddingUnavailableError,
  embed,
  embeddingsConfigured,
} from '../integrations/llm/index.js';
import {
  backfillDue,
  backfillOrder,
  clearBackfillMark,
  markBackfillFailed,
} from '../lib/backfill-marker.js';
import { logger } from '../lib/logger.js';
import { knowledgeEmbedInput } from './entry-input.js';
import { knowledgePort } from './ports.js';

const BATCH_SIZE = 50;

/** Re-embeds knowledge entries stored without a vector while the embeddings service was down. */
async function backfillEntries(): Promise<{ reembedded: number; aborted: boolean }> {
  const md = knowledgeEntries.metadata;
  const rows = await db
    .select({ id: knowledgeEntries.id, title: knowledgeEntries.title, body: knowledgeEntries.body })
    .from(knowledgeEntries)
    .where(
      and(isNull(knowledgeEntries.embedding), isNull(knowledgeEntries.archivedAt), backfillDue(md)),
    )
    .orderBy(backfillOrder(md), asc(knowledgeEntries.updatedAt))
    .limit(BATCH_SIZE);

  let reembedded = 0;
  for (const row of rows) {
    // Guard on embedding IS NULL: a concurrent writer's vector stays.
    const unfilled = and(eq(knowledgeEntries.id, row.id), isNull(knowledgeEntries.embedding));
    try {
      const vector = await embed(
        { surface: 'knowledge' },
        knowledgeEmbedInput(row.title, row.body),
      );
      await db
        .update(knowledgeEntries)
        .set({ embedding: vector, metadata: clearBackfillMark(md) })
        .where(unfilled);
      reembedded++;
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) return { reembedded, aborted: true };
      logger.error(
        { err: (err as Error).message, knowledgeEntryId: row.id },
        'knowledge.backfill: re-embed failed for row, skipping',
      );
      await db
        .update(knowledgeEntries)
        .set({ metadata: markBackfillFailed(md) })
        .where(unfilled);
    }
  }
  return { reembedded, aborted: false };
}

/**
 * Re-runs the item writer for `item_embeddings` rows a provider error or a missing provider left
 * without a vector, from the owner's current head. Every write bumps the row's `updated_at`, so the
 * oldest-first batch rotates and a row that fails again goes to the back.
 */
async function backfillItems(): Promise<{ reembedded: number; aborted: boolean }> {
  if (!embeddingsConfigured()) return { reembedded: 0, aborted: false };
  const rows = await db
    .select({
      id: itemEmbeddings.id,
      requirementId: itemEmbeddings.requirementId,
      feedbackId: itemEmbeddings.feedbackId,
    })
    .from(itemEmbeddings)
    .where(inArray(itemEmbeddings.status, ['failed', 'provider_not_configured']))
    .orderBy(asc(itemEmbeddings.updatedAt))
    .limit(BATCH_SIZE);

  let reembedded = 0;
  for (const row of rows) {
    const status = row.requirementId
      ? await knowledgePort('reembedRequirement')(row.requirementId)
      : await knowledgePort('reembedFeedback')(row.feedbackId as string);
    if (status === 'embedded') reembedded++;
    // the writer folds an outage into `failed`, so a failure ends the sweep rather than
    // spending the batch on a provider that is down; the failed row has already moved to the back
    if (status === 'failed') return { reembedded, aborted: true };
    if (status === null) {
      await db
        .update(itemEmbeddings)
        .set({ updatedAt: new Date() })
        .where(eq(itemEmbeddings.id, row.id));
    }
  }
  return { reembedded, aborted: false };
}

/** The knowledge half of the embedding backfill: entries first, then item vectors. */
export async function runKnowledgeEmbeddingBackfill(): Promise<{
  reembedded: number;
  itemsReembedded: number;
  aborted: boolean;
}> {
  const entries = await backfillEntries();
  const items = entries.aborted ? { reembedded: 0, aborted: true } : await backfillItems();
  return {
    reembedded: entries.reembedded,
    itemsReembedded: items.reembedded,
    aborted: entries.aborted || items.aborted,
  };
}
