import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type MemorySource, memories } from '../db/schema.js';
import { embed } from '../embeddings/index.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';

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
  /** True when text exceeded MAX_EMBED_CHARS and was cut before embedding. */
  truncated: boolean;
}

/**
 * Strict variant — throws on embedding failure or DB upsert failure. Returns
 * the upserted row's id + embeddedAt + a `truncated` flag so explicit callers
 * (REST `POST /api/memory`, MCP `forge_memory.write`, knowledge ingest) can
 * report it.
 */
export async function indexMemory(input: IndexInput): Promise<IndexResult> {
  const truncated = input.text.length > MAX_EMBED_CHARS;
  const trimmed = truncated ? input.text.slice(0, MAX_EMBED_CHARS) : input.text;
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

  const vector = await embed(trimmed);

  const [row] = await db
    .insert(memories)
    .values({
      projectId: input.projectId,
      source: input.source,
      sourceRef: input.sourceRef,
      textContent: trimmed,
      embedding: vector,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [memories.projectId, memories.source, memories.sourceRef],
      set: {
        textContent: sql`excluded.text_content`,
        embedding: sql`excluded.embedding`,
        metadata: sql`excluded.metadata`,
        embeddedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: memories.id, embeddedAt: memories.embeddedAt });

  if (!row) {
    // Shouldn't happen — UPSERT with returning always returns a row.
    throw new Error('memory.indexer: upsert returned no row');
  }
  return { id: row.id, embeddedAt: row.embeddedAt, truncated };
}

/**
 * Best-effort variant — swallows embedding and DB failures with rich
 * structured logging. Use from hook subscribers where the request path must
 * not see indexer errors and a later edit will re-attempt indexing.
 */
export async function indexMemoryBestEffort(input: IndexInput): Promise<void> {
  try {
    await indexMemory(input);
  } catch (err) {
    const meta = {
      err: (err as Error).message,
      projectId: input.projectId,
      source: input.source,
      sourceRef: input.sourceRef,
    };
    // Distinguish embed vs DB by inspecting the error message prefix — both
    // are logged at warn so a bursty embed outage doesn't flood error counters.
    if ((err as Error).message?.includes('embed')) {
      logger.warn(meta, 'memory.indexer: embed failed, skipping');
    } else {
      logger.warn(meta, 'memory.indexer: upsert failed');
    }
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

  unsubs.push(
    bus.on('commentCreated', (p) => {
      if (!p.body) return;
      detach(() =>
        indexMemoryBestEffort({
          projectId: p.projectId,
          source: 'comment',
          sourceRef: p.commentId,
          text: p.body,
          metadata: { issueId: p.issueId },
        }),
      );
    }),
  );

  unsubs.push(
    bus.on('commentUpdated', (p) => {
      detach(() =>
        indexMemoryBestEffort({
          projectId: p.projectId,
          source: 'comment',
          sourceRef: p.commentId,
          text: p.after,
          metadata: { issueId: p.issueId },
        }),
      );
    }),
  );

  unsubs.push(
    bus.on('commentDeleted', (p) => {
      detach(async () => {
        await deleteMemory(p.projectId, 'comment', p.commentId);
      });
    }),
  );

  return () => {
    for (const u of unsubs) u();
    alreadyRegistered = false;
  };
}

/** Test-only. Resets the single-registration guard. */
export function resetMemoryIndexerRegistration(): void {
  alreadyRegistered = false;
}
