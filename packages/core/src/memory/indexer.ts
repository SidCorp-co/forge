import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type MemorySource, memories } from '../db/schema.js';
import { EmbeddingUnavailableError, embed } from '../embeddings/index.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { searchMemories } from './search.js';

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

const MAX_EMBED_CHARS = 8192;

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
   * True when the embeddings service was unavailable and the row was stored
   * WITHOUT a vector (memory-v2 phase 1 degraded write). The row is
   * keyword-searchable immediately; the backfill job re-embeds it once the
   * service recovers. `embeddedAt` is stale/meaningless until then.
   */
  degraded: boolean;
  /**
   * Set when semantic dedup absorbed this write into an existing
   * near-identical row (memory-v2 phase 2): the `sourceRef` of that row.
   * `id` is the absorbing row's id. Callers should reuse this sourceRef for
   * future refinements instead of their requested one.
   */
  dedupedInto?: string;
}

export interface IndexOptions {
  /**
   * memory-v2 phase 2 — semantic dedup, ported from forge-agents crud.ts.
   * When the write would CREATE a new row (no exact natural-key match) but a
   * semantically near-identical row (cosine > DEDUP_THRESHOLD) already exists
   * under the same source, the write refines THAT row instead of inserting a
   * near-duplicate. Exact-key re-writes (intentional refinement) and degraded
   * writes (no vector to compare) bypass dedup. Enabled by the agent-curated
   * write paths for `note`/`knowledge`; never by lifecycle mirrors.
   */
  semanticDedup?: boolean;
}

/**
 * 0.85 mirrors forge-agents. NOTE (proposal open question): tuned on the
 * predecessor's embedding model — re-validate against the configured model
 * before relying on it for aggressive consolidation.
 */
export const DEDUP_THRESHOLD = 0.85;

/**
 * Strict variant — throws on DB upsert failure or non-outage embedding
 * failure. An embeddings OUTAGE (`EmbeddingUnavailableError`) no longer
 * throws: the row is written without a vector and flagged `degraded` so
 * explicit callers (REST `POST /api/memory`, MCP `forge_memory.write`,
 * knowledge ingest) can report it instead of losing the write.
 */
export async function indexMemory(input: IndexInput, opts?: IndexOptions): Promise<IndexResult> {
  const truncated = input.text.length > MAX_EMBED_CHARS;
  const embedText = truncated ? input.text.slice(0, MAX_EMBED_CHARS) : input.text;
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

  let vector: number[] | null = null;
  try {
    vector = await embed(embedText);
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    logger.warn(
      { projectId: input.projectId, source: input.source, sourceRef: input.sourceRef },
      'memory.indexer: embeddings unavailable, storing degraded row for backfill',
    );
  }
  const degraded = vector === null;

  if (opts?.semanticDedup && vector !== null) {
    const target = await findDedupTarget(input, vector);
    if (target) {
      const [updated] = await db
        .update(memories)
        .set({
          textContent: input.text,
          embedding: vector,
          metadata: input.metadata ?? {},
          archivedAt: null,
          embeddedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(memories.id, target.id))
        .returning({ id: memories.id, embeddedAt: memories.embeddedAt });
      if (updated) {
        logger.info(
          {
            projectId: input.projectId,
            source: input.source,
            requestedSourceRef: input.sourceRef,
            dedupedInto: target.sourceRef,
            score: target.score,
          },
          'memory.indexer: semantic dedup absorbed write into existing row',
        );
        return {
          id: updated.id,
          embeddedAt: updated.embeddedAt,
          truncated,
          degraded: false,
          dedupedInto: target.sourceRef,
        };
      }
      // Row vanished between search and update (concurrent delete) — fall
      // through to the normal insert path.
    }
  }

  const [row] = await db
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
        // On a degraded re-write this nulls a previously good vector — wanted:
        // the old vector embeds STALE text; null forces the backfill re-embed.
        embedding: sql`excluded.embedding`,
        metadata: sql`excluded.metadata`,
        // A fresh write revives a decayed/consolidated-away row.
        archivedAt: sql`null`,
        // embeddedAt only advances when a vector was actually written.
        ...(degraded ? {} : { embeddedAt: sql`now()` }),
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: memories.id, embeddedAt: memories.embeddedAt });

  if (!row) {
    // Shouldn't happen — UPSERT with returning always returns a row.
    throw new Error('memory.indexer: upsert returned no row');
  }
  return { id: row.id, embeddedAt: row.embeddedAt, truncated, degraded };
}

/**
 * Dedup target lookup: skip when the exact natural key already exists (the
 * upsert path refines it — that's intentional), otherwise return the closest
 * same-source row above DEDUP_THRESHOLD.
 */
async function findDedupTarget(
  input: IndexInput,
  vector: number[],
): Promise<{ id: string; sourceRef: string; score: number } | null> {
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
  if (!best || best.score <= DEDUP_THRESHOLD) return null;
  return { id: best.id, sourceRef: best.sourceRef, score: best.score };
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
      const text = [p.snapshot.title, p.snapshot.description ?? ''].filter(Boolean).join('\n\n');
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
      const description = (p.after.description ?? '') as string;
      const text = [title, description].filter(Boolean).join('\n\n');
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

  // Comments are deliberately NOT auto-indexed. In a pipeline-driven project
  // the bulk of comments are bot status chatter (triage notes, plan summaries,
  // review verdicts, handoffs) — each create/update would cost an embedding
  // call, yet no automatic read path ever consumes `source:'comment'` memory
  // (the only auto-injection — ci-fix-pattern-query — filters `source:'note'`).
  // Agents that want a comment-worth lesson remembered write it explicitly via
  // `forge_memory.write` as `source:'knowledge'`. `deleteMemory` is still
  // exported for the `forge_memory.delete` tool.

  return () => {
    for (const u of unsubs) u();
    alreadyRegistered = false;
  };
}

/** Test-only. Resets the single-registration guard. */
export function resetMemoryIndexerRegistration(): void {
  alreadyRegistered = false;
}
