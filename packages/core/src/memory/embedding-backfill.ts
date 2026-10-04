import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries, memories } from '../db/schema.js';
import { EmbeddingUnavailableError, embed } from '../integrations/llm/index.js';
import { fillKnowledgeEmbedding, knowledgeEmbedInput } from '../knowledge/index.js';
import { logger } from '../observability/logger.js';

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
      const vector = await embed({ surface: 'memory' }, row.textContent.slice(0, MAX_EMBED_CHARS));
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
      const vector = await embed(
        { surface: 'knowledge' },
        knowledgeEmbedInput(row.title, row.body),
      );
      await fillKnowledgeEmbedding(row.id, vector);
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
