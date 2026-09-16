import { and, eq, sql } from 'drizzle-orm';
import { bodyText } from '../body/prepare.js';
import { db } from '../db/client.js';
import { type MemorySource, memories } from '../db/schema.js';
import { EmbeddingUnavailableError, embed } from '../embeddings/index.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import {
  chunkAndPublish,
  chunkContextPrefix,
  chunkSetMatches,
  invalidateChunks,
} from './chunk-writer.js';
import { chunkText, isChunkedSource } from './chunker.js';
import { loadRetrievalFlags } from './retrieval-flags.js';
import { searchMemories } from './search.js';

type Executor = Pick<typeof db, 'insert'>;

/** The parent row as it LANDED — what the chunk comparison and the race check are both read off. */
interface LandedRow {
  id: string;
  embeddedAt: Date;
  textContent: string;
  metadata: unknown;
  chunkGeneration: number;
  chunkedAt: Date | null;
  hasEmbedding: boolean;
}

function upsertParent(
  exec: Executor,
  input: IndexInput,
  vector: number[] | null,
  preserveUnchangedVector: boolean,
) {
  return exec
    .insert(memories)
    .values({
      projectId: input.projectId,
      source: input.source,
      sourceRef: input.sourceRef,
      textContent: input.text,
      embedding: vector,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [memories.projectId, memories.source, memories.sourceRef],
      set: {
        textContent: sql`excluded.text_content`,
        // cm:guard this CASE is the compare-and-swap for BOTH the outage path and the skip path, and it is why a lost race degrades instead of lying: `excluded.embedding` is null on either, so a writer that moved the text between this run's pre-read and this statement leaves the row with NO vector (which memory/embedding-backfill.ts owns) rather than one that embeds text the row no longer says. When the text is identical the stored vector is still valid and is kept instead of being lost to an outage.
        embedding: preserveUnchangedVector
          ? sql`CASE WHEN ${memories.textContent} = excluded.text_content THEN ${memories.embedding} ELSE excluded.embedding END`
          : sql`excluded.embedding`,
        metadata: sql`excluded.metadata`,
        // A fresh write revives a decayed/consolidated-away row.
        archivedAt: sql`null`,
        // embeddedAt only advances when a vector was actually written.
        ...(vector === null ? {} : { embeddedAt: sql`now()` }),
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: memories.id,
      embeddedAt: memories.embeddedAt,
      textContent: memories.textContent,
      metadata: memories.metadata,
      chunkGeneration: memories.chunkGeneration,
      chunkedAt: memories.chunkedAt,
      hasEmbedding: sql<boolean>`${memories.embedding} is not null`,
    });
}

// cm:guard on a chunked project the invalidate rides the parent upsert's transaction and the chunk embed happens AFTER it commits — from that commit the row is searched through its flat arm only, so a failed re-embed can never leave the previous passages searchable beside text the parent no longer says; a degraded whole-document embed skips the chunk embed too (the same service is down) and the backfill completes the row
// cm:guard the decision to leave the set alone is taken INSIDE that transaction, against the row the upsert returned and never against the pre-read — the upsert locks the parent and every other writer of this set takes the same lock, so a set somebody replaced is seen replaced and rebuilt (ISS-1024)
async function upsertChunkedParent(
  input: IndexInput,
  vector: number[] | null,
  preserveUnchangedVector: boolean,
  outage: boolean,
): Promise<{ row: LandedRow; chunksDegraded: boolean }> {
  const { row, generation } = await db.transaction(async (tx) => {
    const [r] = await upsertParent(tx, input, vector, preserveUnchangedVector);
    if (!r) throw new Error('memory.indexer: upsert returned no row');
    const prefix = await chunkContextPrefix({
      source: input.source,
      sourceRef: input.sourceRef,
      textContent: r.textContent,
      metadata: r.metadata,
    });
    const passages = chunkText(r.textContent);
    if (await chunkSetMatches(tx, r, prefix, passages)) {
      return { row: r, generation: null as number | null };
    }
    return { row: r, generation: await invalidateChunks(tx, r.id) };
  });
  if (generation === null || outage) return { row, chunksDegraded: outage };
  try {
    await chunkAndPublish({
      id: row.id,
      source: input.source,
      sourceRef: input.sourceRef,
      textContent: row.textContent,
      metadata: row.metadata,
      chunkGeneration: generation,
    });
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    logger.warn(
      { projectId: input.projectId, source: input.source, sourceRef: input.sourceRef },
      'memory.indexer: embeddings unavailable for the chunk set, row stays flat-only for backfill',
    );
    return { row, chunksDegraded: true };
  }
  return { row, chunksDegraded: false };
}

// cm:guard ISS-898 — embed the PROJECTION, never the raw body. An `html` component description embedded verbatim spends its vector budget on tag and attribute names, so two issues sharing a template read as similar because they share markup rather than because they share a problem.
function describe(row: { description?: unknown; descriptionFormat?: unknown }): string {
  const description = typeof row.description === 'string' ? row.description : '';
  if (!description) return '';
  const format = typeof row.descriptionFormat === 'string' ? row.descriptionFormat : null;
  return bodyText(description, format);
}

/**
 * Subscribe to issue/comment lifecycle hooks and keep the `memories` table in
 * sync via the embeddings service.
 *
 * Hook work is detached with `queueMicrotask` so it never adds LiteLLM
 * latency to the request path. Hook subscribers use `indexMemoryBestEffort`,
 * which logs and swallows failures — eventually consistent. Explicit callers
 * (REST `POST /api/memory`, MCP `forge_memory.write`, knowledge ingest) use
 * `indexMemory` which throws so the caller can report or retry.
 *
 * If higher durability is required later (bursts, retry-on-process-restart),
 * migrate the detached call to a pg-boss job; the queue is already running.
 */

export const MAX_EMBED_CHARS = 8192;

export interface IndexInput {
  projectId: string;
  source: MemorySource;
  sourceRef: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface IndexResult {
  id: string;
  embeddedAt: Date;
  /**
   * True when text exceeded MAX_EMBED_CHARS and was cut before embedding.
   * The stored `textContent` is always the full text — only the string sent
   * to the embedding model is trimmed.
   */
  truncated: boolean;
  /**
   * True when the embeddings service was unavailable and this write could not
   * finish indexing the row (memory-v2 phase 1 degraded write). Either the row
   * was stored WITHOUT a vector, or — on a chunked project — its passages could
   * not be re-embedded and it is searchable through its flat arm alone. The row
   * is keyword-searchable immediately; the backfill and reindex jobs complete it
   * once the service recovers. `embeddedAt` is stale/meaningless until then.
   */
  degraded: boolean;
  /**
   * Advisory only: the `sourceRef` of an existing same-source row whose text
   * is near-identical (cosine > NEAR_DUPLICATE_THRESHOLD) to this write. The
   * write still landed on the ref the caller named. A caller refining that
   * other record should re-issue the write under THIS ref — an exact-key
   * write is the only way one memory row ever replaces another's text.
   */
  nearDuplicateOf?: string;
  /** Cosine score of `nearDuplicateOf`; set only alongside it. */
  dedupeScore?: number;
}

export interface IndexOptions {
  /**
   * Report (never act on) an existing same-source row whose text is
   * near-identical to this write, as `nearDuplicateOf` + `dedupeScore`.
   * Costs one vector search. Exact-key re-writes and degraded writes (no
   * vector to compare) skip the probe. Enabled by the agent-curated write
   * paths for `note`/`knowledge`; never by lifecycle mirrors.
   */
  nearDuplicateProbe?: boolean;
}

/**
 * 0.85 mirrors forge-agents. NOTE (proposal open question): tuned on the
 * predecessor's embedding model — re-validate against the configured model
 * before reading a hit as anything stronger than "look at this too".
 */
import { NEAR_DUPLICATE_THRESHOLD } from './thresholds.js';

export { NEAR_DUPLICATE_THRESHOLD };

/**
 * Strict variant — throws on DB upsert failure or non-outage embedding
 * failure. An embeddings OUTAGE (`EmbeddingUnavailableError`) no longer
 * throws: the row is written without a vector and flagged `degraded` so
 * explicit callers (REST `POST /api/memory`, MCP `forge_memory.write`,
 * knowledge ingest) can report it instead of losing the write.
 */
/** The stored row's own text and whether it holds a vector — the only two facts the skip reads. */
async function readExisting(
  input: IndexInput,
): Promise<{ textContent: string; hasEmbedding: boolean } | null> {
  const [row] = await db
    .select({
      textContent: memories.textContent,
      hasEmbedding: sql<boolean>`${memories.embedding} is not null`,
    })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, input.projectId),
        eq(memories.source, input.source),
        eq(memories.sourceRef, input.sourceRef),
      ),
    )
    .limit(1);
  return row ?? null;
}

interface WriteOutcome {
  row: LandedRow;
  degraded: boolean;
  /** The skip was taken and the swap refused it: the text moved under the pre-read. */
  raceLost: boolean;
  nearDuplicate: { sourceRef: string; score: number } | null;
}

// cm:guard the skip reads the row's OWN text and nothing derived from it, because the whole-document vector embeds `input.text` cut at MAX_EMBED_CHARS and nothing else. What it does NOT see is a change to the derivation — EMBEDDINGS_MODEL, MAX_EMBED_CHARS, MAX_CHUNK_EMBED_CHARS — which makes every stored vector stale for text that did not move. That was never this path's job (a row nobody rewrites is never re-embedded either); memory/embedding-backfill.ts and memory/chunk-reindex.ts are the operations that own it, and a derivation-version column is what would let the skip see it.
async function writeOnce(
  input: IndexInput,
  opts: IndexOptions | undefined,
  chunked: boolean,
  allowSkip: boolean,
): Promise<WriteOutcome> {
  const existing = allowSkip ? await readExisting(input) : null;
  const skip = existing !== null && existing.textContent === input.text && existing.hasEmbedding;

  let vector: number[] | null = null;
  let outage = false;
  if (!skip) {
    const embedText =
      input.text.length > MAX_EMBED_CHARS ? input.text.slice(0, MAX_EMBED_CHARS) : input.text;
    try {
      vector = await embed(embedText);
    } catch (err) {
      if (!(err instanceof EmbeddingUnavailableError)) throw err;
      outage = true;
      logger.warn(
        { projectId: input.projectId, source: input.source, sourceRef: input.sourceRef },
        'memory.indexer: embeddings unavailable, storing degraded row for backfill',
      );
    }
  }

  // cm:guard ISS-876: the probe REPORTS, it never redirects the write — an absorb can only ever fire on a ref the caller just invented (findNearDuplicate returns null on an exact-key hit), so acting on it overwrites a record nobody named; that destroyed 4 of 6 dated summary rows on forge-dev and the snapshot ref it handed back was archived, hence unreadable through forge_memory.get
  const nearDuplicate =
    opts?.nearDuplicateProbe && vector !== null ? await findNearDuplicate(input, vector) : null;
  if (nearDuplicate) {
    logger.info(
      {
        projectId: input.projectId,
        source: input.source,
        sourceRef: input.sourceRef,
        nearDuplicateOf: nearDuplicate.sourceRef,
        score: nearDuplicate.score,
      },
      'memory.indexer: write is near-identical to an existing row, reporting it to the caller',
    );
  }

  const preserve = skip || outage;
  const written = chunked
    ? await upsertChunkedParent(input, vector, preserve, outage)
    : { row: (await upsertParent(db, input, vector, preserve))[0], chunksDegraded: false };
  const row = written.row;

  if (!row) {
    // Shouldn't happen — UPSERT with returning always returns a row.
    throw new Error('memory.indexer: upsert returned no row');
  }

  const raceLost = skip && !row.hasEmbedding;
  if (raceLost) {
    logger.warn(
      { projectId: input.projectId, source: input.source, sourceRef: input.sourceRef },
      'memory.indexer: the text moved under the skip, re-embedding the text that landed',
    );
  }
  // cm:guard `chunksDegraded` is part of this answer and not a detail of the chunk arm: a write whose whole-document embed was SKIPPED sees no outage of its own, so a chunk publish that met one would otherwise report `degraded: false` while the row has just been invalidated to flat-only retrieval — an explicit caller told its write landed normally when half of it did not (ISS-1024).
  return {
    row,
    degraded: outage || raceLost || written.chunksDegraded,
    raceLost,
    nearDuplicate,
  };
}

/**
 * Strict variant — throws on DB upsert failure or non-outage embedding
 * failure. An embeddings OUTAGE (`EmbeddingUnavailableError`) no longer
 * throws: the row is written without a vector and flagged `degraded` so
 * explicit callers (REST `POST /api/memory`, MCP `forge_memory.write`,
 * knowledge ingest) can report it instead of losing the write.
 *
 * An unchanged text is not re-embedded (ISS-1024). The skip is a
 * compare-and-swap, not a trust: where it loses, the write is retried once with
 * the skip refused, so the row ends holding the vector for the text it carries.
 */
export async function indexMemory(input: IndexInput, opts?: IndexOptions): Promise<IndexResult> {
  const truncated = input.text.length > MAX_EMBED_CHARS;
  if (truncated) {
    logger.warn(
      {
        projectId: input.projectId,
        source: input.source,
        sourceRef: input.sourceRef,
        originalLen: input.text.length,
      },
      'memory.indexer: truncated text before embed',
    );
  }

  const flags = await loadRetrievalFlags(input.projectId);
  const chunked = flags.memoryModel === 'chunked' && isChunkedSource(input.source);

  const first = await writeOnce(input, opts, chunked, true);
  const outcome = first.raceLost ? await writeOnce(input, opts, chunked, false) : first;

  return {
    id: outcome.row.id,
    embeddedAt: outcome.row.embeddedAt,
    truncated,
    degraded: outcome.degraded,
    ...(outcome.nearDuplicate
      ? {
          nearDuplicateOf: outcome.nearDuplicate.sourceRef,
          dedupeScore: outcome.nearDuplicate.score,
        }
      : {}),
  };
}

/**
 * Near-duplicate probe: skip when the exact natural key already exists (that
 * write refines its own row), otherwise return the closest same-source row
 * above NEAR_DUPLICATE_THRESHOLD. Read-only — the caller reports the hit and
 * writes its own ref regardless.
 */
async function findNearDuplicate(
  input: IndexInput,
  vector: number[],
): Promise<{ sourceRef: string; score: number } | null> {
  const [exact] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, input.projectId),
        eq(memories.source, input.source),
        eq(memories.sourceRef, input.sourceRef),
      ),
    )
    .limit(1);
  if (exact) return null;

  const similar = await searchMemories({
    projectId: input.projectId,
    queryVec: vector,
    topK: 1,
    sourceFilter: [input.source],
  });
  const best = similar[0];
  if (!best || best.score <= NEAR_DUPLICATE_THRESHOLD) return null;
  return { sourceRef: best.sourceRef, score: best.score };
}

/**
 * Best-effort variant — swallows failures with structured logging. Use from
 * hook subscribers where the request path must not see indexer errors and a
 * later edit will re-attempt indexing. Embeddings OUTAGES never reach here —
 * `indexMemory` absorbs them as degraded writes — so anything caught is a DB
 * failure or a non-outage embed error (e.g. dimension mismatch).
 */
export async function indexMemoryBestEffort(input: IndexInput): Promise<void> {
  try {
    await indexMemory(input);
  } catch (err) {
    // warn, not error, so a bursty outage doesn't flood error counters.
    logger.warn(
      {
        err: (err as Error).message,
        projectId: input.projectId,
        source: input.source,
        sourceRef: input.sourceRef,
      },
      'memory.indexer: write failed',
    );
  }
}

/**
 * Delete a memory row by its natural key. Returns the number of rows removed
 * (0 or 1 because of the unique constraint on `(projectId, source, sourceRef)`).
 * Idempotent — never throws on missing row.
 */
export async function deleteMemory(
  projectId: string,
  source: MemorySource,
  sourceRef: string,
): Promise<number> {
  const result = await db
    .delete(memories)
    .where(
      and(
        eq(memories.projectId, projectId),
        eq(memories.source, source),
        eq(memories.sourceRef, sourceRef),
      ),
    )
    .returning({ id: memories.id });
  return result.length;
}

/**
 * Attach indexer subscribers to the hook bus. Returns an unsubscribe function
 * for tests; production code should let the subscriptions live for the
 * process lifetime.
 */
let alreadyRegistered = false;

export function registerMemoryIndexer(bus: HooksBus): () => void {
  if (alreadyRegistered) {
    // Prevent duplicate subscriptions when src/index.ts is imported by tests
    // that also spin up their own subscribers. The boot wiring calls this
    // once per process; the second caller gets a no-op unsubscribe.
    return () => undefined;
  }
  alreadyRegistered = true;
  const detach = (fn: () => Promise<void>) =>
    queueMicrotask(() => {
      fn().catch((err) => {
        logger.error({ err: (err as Error).message }, 'memory.indexer: detached task failed');
      });
    });
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('issueCreated', (p) => {
      const text = [p.snapshot.title, describe(p.snapshot)].filter(Boolean).join('\n\n');
      if (!text) return;
      detach(() =>
        indexMemoryBestEffort({
          projectId: p.projectId,
          source: 'issue',
          sourceRef: p.issueId,
          text,
          metadata: { priority: p.snapshot.priority, category: p.snapshot.category ?? undefined },
        }),
      );
    }),
  );

  unsubs.push(
    bus.on('issueUpdated', (p) => {
      if (!p.fields.includes('title') && !p.fields.includes('description')) return;
      const title = (p.after.title ?? '') as string;
      const text = [title, describe(p.after)].filter(Boolean).join('\n\n');
      if (!text) return;
      detach(() =>
        indexMemoryBestEffort({
          projectId: p.projectId,
          source: 'issue',
          sourceRef: p.issueId,
          text,
          metadata: {
            priority: p.after.priority as string | undefined,
            category: (p.after.category as string | null) ?? undefined,
          },
        }),
      );
    }),
  );

  // cm:guard comments are deliberately NOT auto-indexed, and subscribing them here is the mistake to avoid: on a pipeline-driven project most comments are agent status chatter, so every create and update would buy an embedding call, and nothing reads `source:'comment'` memory automatically. A comment worth remembering is written explicitly as `source:'knowledge'`.

  return () => {
    for (const u of unsubs) u();
    alreadyRegistered = false;
  };
}

/** Test-only. Resets the single-registration guard. */
export function resetMemoryIndexerRegistration(): void {
  alreadyRegistered = false;
}
