// The chunk write path shared by the indexer, the embedding backfill and the
// reindex job (retrieval v3 phase 2, ISS-906): invalidate the parent's chunk
// set inside the parent's own transaction, embed outside any transaction,
// publish guarded by the generation read at invalidation.

import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type MemorySource, memories, projects } from '../db/schema.js';
import { memoryChunks } from '../db/schema-memory-chunks.js';
import { embedBatch } from '../embeddings/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { chunkText, contextPrefix, isChunkedSource } from './chunker.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MAX_CHUNK_EMBED_CHARS = 8192;

/** What `contextPrefix` needs, before the issue label is resolved. */
export type PrefixInput = Omit<ChunkParent, 'id' | 'chunkGeneration'>;

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

async function issueLabel(parent: PrefixInput): Promise<string | undefined> {
  if (parent.source !== 'issue') return undefined;
  const [row] = await db
    .select({ issSeq: issues.issSeq, issuePrefix: projects.issuePrefix })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, parent.sourceRef))
    .limit(1);
  return row ? formatIssueRef(row.issuePrefix, row.issSeq) : undefined;
}

/** What every passage of this parent is prefixed with before embedding — the ONE writer of that
 *  string, so the write path, the reindex and the skip predicate cannot compute it differently. */
export async function chunkContextPrefix(parent: PrefixInput): Promise<string> {
  return contextPrefix({ ...parent, issueLabel: await issueLabel(parent) });
}

/** True when the live set at the parent's generation IS the set this write would publish. */
export async function chunkSetMatches(
  tx: Tx,
  parent: { id: string; chunkGeneration: number; chunkedAt: Date | null },
  prefix: string,
  passages: string[],
): Promise<boolean> {
  if (parent.chunkedAt === null) return false;
  const rows = await tx
    .select({
      chunkIndex: memoryChunks.chunkIndex,
      textContent: memoryChunks.textContent,
      contextPrefix: memoryChunks.contextPrefix,
      embedded: sql<boolean>`${memoryChunks.embedding} is not null`,
    })
    .from(memoryChunks)
    .where(
      and(
        eq(memoryChunks.memoryId, parent.id),
        eq(memoryChunks.generation, parent.chunkGeneration),
      ),
    )
    .orderBy(asc(memoryChunks.chunkIndex));
  if (rows.length !== passages.length) return false;
  return rows.every(
    (r, i) =>
      r.chunkIndex === i &&
      r.embedded === true &&
      r.contextPrefix === prefix &&
      r.textContent === passages[i],
  );
}

/** Steps 2 and 3: embed the prefixed passages (an outage throws EmbeddingUnavailableError to the caller), then publish under the parent's generation. */
export async function chunkAndPublish(
  parent: ChunkParent,
): Promise<{ chunks: number; published: boolean }> {
  if (!isChunkedSource(parent.source)) return { chunks: 0, published: false };
  const prefix = await chunkContextPrefix(parent);
  const passages = chunkText(parent.textContent);
  const vectors = await embedBatch(
    passages.map((p) => `${prefix}\n${p}`.slice(0, MAX_CHUNK_EMBED_CHARS)),
  );
  const generation = parent.chunkGeneration;

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
