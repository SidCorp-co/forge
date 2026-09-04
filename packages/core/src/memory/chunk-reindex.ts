// The flip to the chunked memory model as an operation (retrieval v3 phase 2,
// ISS-906): an estimate before it, a state with counts during it, cancel,
// retry and revert. The job is idempotent and resumable by construction — it
// only ever asks for rows whose current generation has no published chunk set.

import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appConfig, memories } from '../db/schema.js';
import { type MemoryReindexState, memoryChunks } from '../db/schema-memory-chunks.js';
import { EmbeddingUnavailableError } from '../embeddings/index.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { chunkAndPublish, loadChunkParent } from './chunk-writer.js';
import {
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  CHUNKED_SOURCES,
  SINGLE_CHUNK_BELOW,
} from './chunker.js';

export const MEMORY_CHUNK_REINDEX_QUEUE = 'memory-chunk-reindex';
export const MEMORY_CHUNK_PURGE_QUEUE = 'memory-chunk-purge';
export const REINDEX_BATCH_SIZE = 50;
export const CHUNK_PURGE_DELAY_SECONDS = 7 * 24 * 3600;
const SECONDS_PER_MEMORY = 0.6;

export interface MemoryReindex {
  state: MemoryReindexState;
  total: number;
  done: number;
  remaining: number;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastBatchAt?: string;
  lastError?: string;
}

export interface ReindexEstimate {
  memories: number;
  totalChars: number;
  estimatedChunks: number;
  estimatedEmbedCalls: number;
  estimatedMinutes: number;
}

const chunkable = (projectId: string) =>
  and(
    eq(memories.projectId, projectId),
    isNull(memories.archivedAt),
    inArray(memories.source, [...CHUNKED_SOURCES]),
  );

/** What a flip would cost, from one SELECT over the rows the write path would chunk — never a guess. */
export async function estimateReindex(projectId: string): Promise<ReindexEstimate> {
  const stride = CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS;
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      chars: sql<number>`coalesce(sum(length(${memories.textContent})), 0)::bigint`,
      chunks: sql<number>`coalesce(sum(CASE WHEN length(${memories.textContent}) < ${SINGLE_CHUNK_BELOW} THEN 1 ELSE ceil(length(${memories.textContent})::numeric / ${stride}) END), 0)::int`,
    })
    .from(memories)
    .where(chunkable(projectId));
  const count = Number(row?.count ?? 0);
  return {
    memories: count,
    totalChars: Number(row?.chars ?? 0),
    estimatedChunks: Number(row?.chunks ?? 0),
    estimatedEmbedCalls: count,
    estimatedMinutes: Math.ceil((count * SECONDS_PER_MEMORY) / 60),
  };
}

export async function readReindex(projectId: string): Promise<MemoryReindex | null> {
  const [row] = await db
    .select({ reindex: appConfig.memoryReindex })
    .from(appConfig)
    .where(eq(appConfig.projectId, projectId))
    .limit(1);
  const value = row?.reindex as Partial<MemoryReindex> | undefined;
  return value && typeof value.state === 'string' ? (value as MemoryReindex) : null;
}

// cm:guard `memory_reindex` is written ONLY here and by the memory-model routes, as a jsonb merge — PUT /api/app-config refuses the key (ISS-904), so a stale client copy of the row cannot erase a running migration's state
export async function writeReindex(
  projectId: string,
  patch: Partial<MemoryReindex>,
): Promise<void> {
  await db
    .update(appConfig)
    .set({
      memoryReindex: sql`${appConfig.memoryReindex} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: sql`now()`,
    })
    .where(eq(appConfig.projectId, projectId));
}

export const isLive = (r: MemoryReindex | null): boolean =>
  r !== null && (r.state === 'queued' || r.state === 'running');

/** Rows the chunked model owns for the project, and how many still have no published passage set — the resume arithmetic every state write uses. */
export async function countPending(projectId: string): Promise<{ total: number; pending: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) FILTER (WHERE ${memories.chunkedAt} IS NULL)::int`,
    })
    .from(memories)
    .where(chunkable(projectId));
  return { total: Number(row?.total ?? 0), pending: Number(row?.pending ?? 0) };
}

async function nextBatch(projectId: string, skip: string[]) {
  const where = [chunkable(projectId), isNull(memories.chunkedAt), isNotNull(memories.embedding)];
  if (skip.length > 0) where.push(notInArray(memories.id, skip));
  return db
    .select({ id: memories.id })
    .from(memories)
    .where(and(...where))
    .orderBy(asc(memories.updatedAt))
    .limit(REINDEX_BATCH_SIZE);
}

// cm:guard the state is re-read before EVERY batch and the loop asks only for `chunked_at IS NULL` rows — that is what makes DELETE (cancel) stop it between batches, a retry resume from where it stopped, and a restart mid-run the same case as a retry; a row that fails for a non-outage reason is skipped for the rest of this run so it cannot be re-selected forever
export async function runChunkReindex(projectId: string): Promise<MemoryReindex | null> {
  let state = await readReindex(projectId);
  if (!isLive(state)) return state;
  const now = () => new Date().toISOString();
  const skip: string[] = [];
  await writeReindex(projectId, { state: 'running', startedAt: now() });

  for (;;) {
    state = await readReindex(projectId);
    if (state?.state !== 'running') return state;
    const rows = await nextBatch(projectId, skip);
    if (rows.length === 0) break;
    for (const row of rows) {
      const parent = await loadChunkParent(row.id);
      if (!parent) continue;
      try {
        await chunkAndPublish(parent);
      } catch (err) {
        if (err instanceof EmbeddingUnavailableError) {
          const counts = await countPending(projectId);
          await writeReindex(projectId, {
            state: 'failed',
            lastError: err.message,
            done: counts.total - counts.pending,
            remaining: counts.pending,
            finishedAt: now(),
          });
          return readReindex(projectId);
        }
        skip.push(row.id);
        logger.error(
          { err: (err as Error).message, memoryId: row.id, projectId },
          'memory.reindex: chunk publish failed for row, skipping for this run',
        );
      }
    }
    const counts = await countPending(projectId);
    await writeReindex(projectId, {
      total: counts.total,
      done: counts.total - counts.pending,
      remaining: counts.pending,
      lastBatchAt: now(),
    });
  }

  const counts = await countPending(projectId);
  await writeReindex(projectId, {
    state: 'completed',
    total: counts.total,
    done: counts.total - counts.pending,
    remaining: counts.pending,
    finishedAt: now(),
  });
  await db
    .update(appConfig)
    .set({ lastBackfillAt: sql`now()` })
    .where(eq(appConfig.projectId, projectId));
  return readReindex(projectId);
}

/** Revert's second half: a week after a flip back to flat, drop the passages — unless the project has since flipped again, in which case they are the live set and stay. */
export async function runChunkPurge(projectId: string): Promise<{ purged: boolean }> {
  const [cfg] = await db
    .select({ model: appConfig.memoryModel })
    .from(appConfig)
    .where(eq(appConfig.projectId, projectId))
    .limit(1);
  if (cfg?.model !== 'flat') return { purged: false };
  await db.transaction(async (tx) => {
    await tx
      .delete(memoryChunks)
      .where(
        inArray(
          memoryChunks.memoryId,
          tx.select({ id: memories.id }).from(memories).where(eq(memories.projectId, projectId)),
        ),
      );
    await tx
      .update(memories)
      .set({ chunkedAt: null })
      .where(and(eq(memories.projectId, projectId), isNotNull(memories.chunkedAt)));
  });
  return { purged: true };
}

export async function enqueueChunkReindex(projectId: string): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss send signature varies
  await (boss as any).send(
    MEMORY_CHUNK_REINDEX_QUEUE,
    { projectId },
    { singletonKey: projectId, retryLimit: 0 },
  );
}

export async function enqueueChunkPurge(projectId: string): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss send signature varies
  await (boss as any).send(
    MEMORY_CHUNK_PURGE_QUEUE,
    { projectId },
    { singletonKey: `purge:${projectId}`, startAfter: CHUNK_PURGE_DELAY_SECONDS, retryLimit: 0 },
  );
}

let registered = false;

export async function registerChunkReindex(): Promise<void> {
  if (registered) return;
  for (const [queue, run] of [
    [MEMORY_CHUNK_REINDEX_QUEUE, runChunkReindex],
    [MEMORY_CHUNK_PURGE_QUEUE, runChunkPurge],
  ] as const) {
    // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
    await (boss as any).createQueue(queue);
    // biome-ignore lint/suspicious/noExplicitAny: handler arg shape stabilised at runtime
    await (boss as any).work(queue, { batchSize: 1 }, async (arg: any) => {
      const entries = Array.isArray(arg) ? arg : [arg];
      for (const entry of entries) {
        const projectId = entry?.data?.projectId as unknown;
        if (typeof projectId !== 'string') continue;
        try {
          const result = await run(projectId);
          logger.info({ projectId, queue, result }, 'memory.reindex: job finished');
        } catch (err) {
          logger.error(
            { err: (err as Error).message, projectId, queue },
            'memory.reindex: job threw',
          );
        }
      }
    });
  }
  registered = true;
}
