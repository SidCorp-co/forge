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
 * Work is detached with `queueMicrotask` so it never adds LiteLLM latency to
 * the request path — `HooksBus.emit` awaits subscribers serially, and a naive
 * `await indexMemory(...)` would block every mutation on a remote embedding
 * call. The trade-off is "memories eventually consistent"; if indexing fails,
 * we log at warn and drop — a subsequent edit will re-attempt.
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

export async function indexMemory(input: IndexInput): Promise<void> {
  const trimmed =
    input.text.length > MAX_EMBED_CHARS ? input.text.slice(0, MAX_EMBED_CHARS) : input.text;
  if (trimmed !== input.text) {
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

  let vector: number[];
  try {
    vector = await embed(trimmed);
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        projectId: input.projectId,
        source: input.source,
        sourceRef: input.sourceRef,
      },
      'memory.indexer: embed failed, skipping',
    );
    return;
  }

  try {
    await db
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
      });
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        projectId: input.projectId,
        source: input.source,
        sourceRef: input.sourceRef,
      },
      'memory.indexer: upsert failed',
    );
  }
}

export async function deleteMemory(
  projectId: string,
  source: MemorySource,
  sourceRef: string,
): Promise<void> {
  await db
    .delete(memories)
    .where(
      and(
        eq(memories.projectId, projectId),
        eq(memories.source, source),
        eq(memories.sourceRef, sourceRef),
      ),
    );
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
        indexMemory({
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
        indexMemory({
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
        indexMemory({
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
        indexMemory({
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
      detach(() => deleteMemory(p.projectId, 'comment', p.commentId));
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
