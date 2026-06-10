import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memories } from '../db/schema.js';
import { EmbeddingUnavailableError, embed } from '../embeddings/index.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';

/**
 * memory-v2 phase 1 — re-embed rows written while the embeddings service was
 * down (degraded writes store `embedding = NULL`; see indexer.ts). Until the
 * backfill runs, those rows are keyword-searchable only.
 *
 * Each sweep processes a bounded batch oldest-first; the 5-min schedule
 * drains any realistic backlog quickly without hammering a service that may
 * be mid-recovery. An `EmbeddingUnavailableError` aborts the sweep early —
 * the service is still down, retry next tick.
 */

export const MEMORY_EMBED_BACKFILL_QUEUE = 'memory-embedding-backfill';
const BATCH_SIZE = 50;
const MAX_EMBED_CHARS = 8192;

export async function runEmbeddingBackfill(): Promise<{
  reembedded: number;
  aborted: boolean;
  durationMs: number;
}> {
  const t0 = Date.now();
  const rows = await db
    .select({ id: memories.id, textContent: memories.textContent })
    .from(memories)
    .where(isNull(memories.embedding))
    .orderBy(asc(memories.updatedAt))
    .limit(BATCH_SIZE);

  let reembedded = 0;
  let aborted = false;

  for (const row of rows) {
    try {
      const vector = await embed(row.textContent.slice(0, MAX_EMBED_CHARS));
      // Guard on embedding IS NULL: if a concurrent real write re-embedded
      // the row since the select, its fresher vector wins.
      await db
        .update(memories)
        .set({ embedding: vector, embeddedAt: new Date() })
        .where(and(eq(memories.id, row.id), isNull(memories.embedding)));
      reembedded++;
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        aborted = true;
        break;
      }
      // Row-level failure (e.g. dimension mismatch) — log and continue so one
      // poisoned row can't wedge the whole backlog.
      logger.error(
        { err: (err as Error).message, memoryId: row.id },
        'memory.backfill: re-embed failed for row, skipping',
      );
    }
  }

  return { reembedded, aborted, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerEmbeddingBackfill(): Promise<void> {
  if (registered) return;
  // pg-boss v10 requires explicit createQueue before schedule/work can reference it.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(MEMORY_EMBED_BACKFILL_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(MEMORY_EMBED_BACKFILL_QUEUE, async () => {
    try {
      const result = await runEmbeddingBackfill();
      if (result.reembedded > 0 || result.aborted) {
        logger.info(result, 'memory.backfill: sweep complete');
      }
    } catch (err) {
      logger.error({ err }, 'memory.backfill: sweep failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(MEMORY_EMBED_BACKFILL_QUEUE, '*/5 * * * *');
  registered = true;
}

export function resetEmbeddingBackfillForTest(): void {
  registered = false;
}
