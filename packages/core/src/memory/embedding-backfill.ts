import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memories } from '../db/schema.js';
import { EmbeddingUnavailableError, embed } from '../integrations/llm/index.js';
import {
  backfillDue,
  backfillOrder,
  clearBackfillMark,
  markBackfillFailed,
} from '../lib/backfill-marker.js';
import { logger } from '../lib/logger.js';
import { MAX_EMBED_CHARS } from './indexer.js';

/**
 * memory-v2 phase 1 — re-embed rows written while the embeddings service was
 * down (degraded writes store `embedding = NULL`; see indexer.ts). Until the
 * backfill runs, those rows are keyword-searchable only.
 *
 * Each sweep processes a bounded batch oldest-first, rows whose last attempt
 * failed behind the rest; the 5-min schedule drains any realistic backlog
 * quickly without hammering a service that may be mid-recovery. An
 * `EmbeddingUnavailableError` aborts the sweep early — the service is still
 * down, retry next tick.
 */

const BATCH_SIZE = 50;

export async function runEmbeddingBackfill(): Promise<{ reembedded: number; aborted: boolean }> {
  const md = memories.metadata;
  const rows = await db
    .select({ id: memories.id, textContent: memories.textContent })
    .from(memories)
    .where(and(isNull(memories.embedding), backfillDue(md)))
    .orderBy(backfillOrder(md), asc(memories.updatedAt))
    .limit(BATCH_SIZE);

  let reembedded = 0;
  for (const row of rows) {
    // Guard on embedding IS NULL: if a concurrent real write re-embedded
    // the row since the select, its fresher vector wins.
    const unfilled = and(eq(memories.id, row.id), isNull(memories.embedding));
    try {
      const vector = await embed({ surface: 'memory' }, row.textContent.slice(0, MAX_EMBED_CHARS));
      await db
        .update(memories)
        .set({ embedding: vector, embeddedAt: new Date(), metadata: clearBackfillMark(md) })
        .where(unfilled);
      reembedded++;
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) return { reembedded, aborted: true };
      logger.error(
        { err: (err as Error).message, memoryId: row.id },
        'memory.backfill: re-embed failed for row, skipping',
      );
      await db
        .update(memories)
        .set({ metadata: markBackfillFailed(md) })
        .where(unfilled);
    }
  }
  return { reembedded, aborted: false };
}
