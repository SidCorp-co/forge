import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appConfig, knowledgeEntries, memories } from '../db/schema.js';
import { EmbeddingUnavailableError, embed } from '../embeddings/index.js';
import { knowledgeEmbedInput } from '../knowledge/service.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { chunkAndPublish, loadChunkParent } from './chunk-writer.js';
import { CHUNKED_SOURCES } from './chunker.js';

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
  knowledgeReembedded: number;
  aborted: boolean;
  durationMs: number;
}> {
  const t0 = Date.now();
  const memoriesSweep = await backfillMemories();
  const knowledgeSweep = memoriesSweep.aborted
    ? { reembedded: 0, aborted: true }
    : await backfillKnowledge();
  return {
    reembedded: memoriesSweep.reembedded,
    knowledgeReembedded: knowledgeSweep.reembedded,
    aborted: memoriesSweep.aborted || knowledgeSweep.aborted,
    durationMs: Date.now() - t0,
  };
}

async function backfillMemories(): Promise<{ reembedded: number; aborted: boolean }> {
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

  return { reembedded, aborted };
}

// cm:guard knowledge_entries is swept by the SAME job as memories — knowledge/service.ts stores `embedding = NULL` on a degraded upsert and logs "storing degraded row for backfill", and until 2026-09-05 no backfill read that table, so an entry written during an embeddings outage stayed keyword-only until its body changed (live: anhome 6 of 56, pixelight 5 of 9, sid-desk 4 of 5 entries without a vector). The text embedded is knowledge/service.ts:knowledgeEmbedInput, the upsert's own
async function backfillKnowledge(): Promise<{ reembedded: number; aborted: boolean }> {
  const rows = await db
    .select({ id: knowledgeEntries.id, title: knowledgeEntries.title, body: knowledgeEntries.body })
    .from(knowledgeEntries)
    .where(and(isNull(knowledgeEntries.embedding), isNull(knowledgeEntries.archivedAt)))
    .orderBy(asc(knowledgeEntries.updatedAt))
    .limit(BATCH_SIZE);

  let reembedded = 0;
  let aborted = false;
  for (const row of rows) {
    try {
      const vector = await embed(knowledgeEmbedInput(row.title, row.body));
      await db
        .update(knowledgeEntries)
        .set({ embedding: vector })
        .where(and(eq(knowledgeEntries.id, row.id), isNull(knowledgeEntries.embedding)));
      reembedded++;
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        aborted = true;
        break;
      }
      logger.error(
        { err: (err as Error).message, knowledgeEntryId: row.id },
        'knowledge.backfill: re-embed failed for row, skipping',
      );
    }
  }
  return { reembedded, aborted };
}

/** The chunked-project rows whose current generation has no published passage set, oldest first — a degraded write, a failed re-embed or a flip that has not reached them yet. */
export async function selectUnchunked(limit: number, projectId?: string) {
  const where = [
    eq(appConfig.memoryModel, 'chunked'),
    isNull(memories.chunkedAt),
    isNull(memories.archivedAt),
    isNotNull(memories.embedding),
    inArray(memories.source, [...CHUNKED_SOURCES]),
  ];
  if (projectId) where.push(eq(memories.projectId, projectId));
  return db
    .select({ id: memories.id })
    .from(memories)
    .innerJoin(appConfig, eq(appConfig.projectId, memories.projectId))
    .where(and(...where))
    .orderBy(asc(memories.updatedAt))
    .limit(limit);
}

// cm:guard the chunk backfill only takes rows whose whole-document `embedding` is already there — a degraded row is completed by runEmbeddingBackfill first, in the same sweep, and chunking it before that would spend a second batch of calls against a service the first query just found down
export async function runChunkBackfill(): Promise<{
  chunked: number;
  aborted: boolean;
  durationMs: number;
}> {
  const t0 = Date.now();
  const rows = await selectUnchunked(BATCH_SIZE);
  let chunked = 0;
  let aborted = false;
  for (const row of rows) {
    const parent = await loadChunkParent(row.id);
    if (!parent) continue;
    try {
      const result = await chunkAndPublish(parent);
      if (result.published) chunked++;
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        aborted = true;
        break;
      }
      logger.error(
        { err: (err as Error).message, memoryId: row.id },
        'memory.backfill: chunk publish failed for row, skipping',
      );
    }
  }
  return { chunked, aborted, durationMs: Date.now() - t0 };
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
      if (result.reembedded > 0 || result.knowledgeReembedded > 0 || result.aborted) {
        logger.info(result, 'memory.backfill: sweep complete');
      }
      if (!result.aborted) {
        const chunks = await runChunkBackfill();
        if (chunks.chunked > 0 || chunks.aborted) {
          logger.info(chunks, 'memory.backfill: chunk sweep complete');
        }
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
