import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memories } from '../db/schema.js';
import { logger } from '../logger.js';

/**
 * Recall-feedback loop (ISS-603). Agents are instructed to verify memory
 * hits against live code before acting; this service is where that verdict
 * lands instead of being discarded:
 *
 *  - `confirmed` → stamp `last_verified_at`. Decay treats it as activity, so
 *    a recently-confirmed row is never archived as "unused".
 *  - `outdated`  → archive immediately and append the evidence to
 *    `metadata.feedback` (capped). Archive is soft — a fresh write to the
 *    same natural key revives the row (indexer resets `archived_at`); hard
 *    purge happens after the existing 90-day grace in the decay job.
 *
 * Scope: agent-curated sources only (`note`, `knowledge`) — lifecycle
 * mirrors (issue/decision/policy) track their source records, so feedback
 * about those belongs on the record itself.
 *
 * Does NOT check authorization — callers must verify project membership
 * before invoking.
 */

export const FEEDBACK_SOURCES = ['note', 'knowledge'] as const;

/** Last N feedback entries kept on `metadata.feedback`. */
export const FEEDBACK_HISTORY_CAP = 10;

export const memoryFeedbackInputSchema = z.object({
  projectId: z.uuid(),
  source: z.enum(FEEDBACK_SOURCES),
  sourceRef: z.string().trim().min(1).max(512),
  verdict: z.enum(['confirmed', 'outdated']),
  // What the verdict was checked against (file, commit, observed behaviour).
  // Required for `outdated` — enforced in runMemoryFeedback, not the schema,
  // so the derived MCP JSON schema stays a plain object.
  evidence: z.string().trim().min(1).max(2000).optional(),
});

export type MemoryFeedbackInput = z.infer<typeof memoryFeedbackInputSchema>;

export class MemoryFeedbackValidationError extends Error {}

export interface MemoryFeedbackResult {
  found: boolean;
  /** What actually happened: verified | archived | noop (missing or already archived). */
  action: 'verified' | 'archived' | 'noop';
}

export async function runMemoryFeedback(input: MemoryFeedbackInput): Promise<MemoryFeedbackResult> {
  if (input.verdict === 'outdated' && !input.evidence) {
    throw new MemoryFeedbackValidationError(
      'evidence is required for verdict=outdated — state what disproved the row',
    );
  }

  const [row] = await db
    .select({ id: memories.id, metadata: memories.metadata, archivedAt: memories.archivedAt })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, input.projectId),
        eq(memories.source, input.source),
        eq(memories.sourceRef, input.sourceRef),
      ),
    )
    .limit(1);

  if (!row) return { found: false, action: 'noop' };
  // Archived rows are hidden from every read surface; feedback on one is a
  // stale pointer from an old session — ignore rather than resurrect state.
  if (row.archivedAt !== null) return { found: true, action: 'noop' };

  if (input.verdict === 'confirmed') {
    await db.update(memories).set({ lastVerifiedAt: sql`now()` }).where(eq(memories.id, row.id));
    return { found: true, action: 'verified' };
  }

  const previous = (row.metadata as Record<string, unknown>)?.feedback;
  const history = Array.isArray(previous) ? previous : [];
  history.push({
    verdict: 'outdated',
    evidence: input.evidence,
    at: new Date().toISOString(),
  });

  await db
    .update(memories)
    .set({
      archivedAt: sql`now()`,
      metadata: {
        ...(row.metadata as Record<string, unknown>),
        feedback: history.slice(-FEEDBACK_HISTORY_CAP),
      },
    })
    .where(eq(memories.id, row.id));

  logger.info(
    {
      projectId: input.projectId,
      source: input.source,
      sourceRef: input.sourceRef,
      evidence: input.evidence,
    },
    'memory.feedback: row archived as outdated',
  );
  return { found: true, action: 'archived' };
}
