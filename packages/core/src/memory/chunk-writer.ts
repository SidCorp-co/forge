// The chunk write path shared by the indexer, the embedding backfill and the
// reindex job (retrieval v3 phase 2, ISS-906): invalidate the parent's chunk
// set inside the parent's own transaction, embed outside any transaction,
// publish guarded by the generation read at invalidation.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type MemorySource, memories } from '../db/schema.js';
import { memoryChunks } from '../db/schema-memory-chunks.js';
import { embedBatch } from '../embeddings/index.js';
import { chunkText, contextPrefix, isChunkedSource } from './chunker.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MAX_CHUNK_EMBED_CHARS = 8192;

export interface ChunkParent {
  id: string;
  source: MemorySource;
  sourceRef: string;
  textContent: string;
  metadata: unknown;
  chunkGeneration: number;
}

/** Step 1 — in the caller's transaction: bump the generation, clear `chunked_at`, drop the old set. Returns the generation the new set must carry. */
export async function invalidateChunks(tx: Tx, memoryId: string): Promise<number> {
  const [row] = await tx
    .update(memories)
    .set({ chunkGeneration: sql`${memories.chunkGeneration} + 1`, chunkedAt: null })
    .where(eq(memories.id, memoryId))
    .returning({ generation: memories.chunkGeneration });
  await tx.delete(memoryChunks).where(eq(memoryChunks.memoryId, memoryId));
  if (!row) throw new Error(`memory.chunks: invalidate found no memory ${memoryId}`);
  return row.generation;
}

async function issueLabel(parent: ChunkParent): Promise<string | undefined> {
  if (parent.source !== 'issue') return undefined;
  const [row] = await db
    .select({ issSeq: issues.issSeq })
    .from(issues)
    .where(eq(issues.id, parent.sourceRef))
    .limit(1);
  return row ? `ISS-${row.issSeq}` : undefined;
}

/** Steps 2 and 3: embed the prefixed passages (an outage throws EmbeddingUnavailableError to the caller), then publish under the parent's generation. */
export async function chunkAndPublish(
  parent: ChunkParent,
): Promise<{ chunks: number; published: boolean }> {
  if (!isChunkedSource(parent.source)) return { chunks: 0, published: false };
  const prefix = contextPrefix({ ...parent, issueLabel: await issueLabel(parent) });
  const passages = chunkText(parent.textContent);
  const vectors = await embedBatch(
    passages.map((p) => `${prefix}\n${p}`.slice(0, MAX_CHUNK_EMBED_CHARS)),
  );
  const generation = parent.chunkGeneration;

  // cm:guard publish is ONE transaction guarded by `chunk_generation = generation` — a concurrent write that bumped the generation between embed and publish makes the guard match nothing, and then the set just inserted is deleted here rather than left behind: the search join would never select it, but a leftover set is a second copy of text the parent no longer says
  return db.transaction(async (tx) => {
    await tx
      .insert(memoryChunks)
      .values(
        passages.map((text, i) => ({
          memoryId: parent.id,
          chunkIndex: i,
          textContent: text,
          contextPrefix: prefix,
          embedding: vectors[i] ?? null,
          generation,
        })),
      )
      .onConflictDoNothing();
    const [published] = await tx
      .update(memories)
      .set({ chunkedAt: sql`now()` })
      .where(and(eq(memories.id, parent.id), eq(memories.chunkGeneration, generation)))
      .returning({ id: memories.id });
    if (!published) {
      await tx
        .delete(memoryChunks)
        .where(and(eq(memoryChunks.memoryId, parent.id), eq(memoryChunks.generation, generation)));
      return { chunks: 0, published: false };
    }
    return { chunks: passages.length, published: true };
  });
}

/** The parent columns the chunk path needs, read fresh so the generation is the one the guard compares against. */
export async function loadChunkParent(memoryId: string): Promise<ChunkParent | null> {
  const [row] = await db
    .select({
      id: memories.id,
      source: memories.source,
      sourceRef: memories.sourceRef,
      textContent: memories.textContent,
      metadata: memories.metadata,
      chunkGeneration: memories.chunkGeneration,
    })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);
  return row ? { ...row, source: row.source as MemorySource } : null;
}
