import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memoryCandidates } from '../db/schema.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';

export const CANDIDATES_DECAY_QUEUE = 'memory-candidates-decay';
export const CANDIDATES_DECAY_DAYS = 14;
export const CANDIDATES_DECAY_CONFIDENCE_THRESHOLD = 0.5;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export interface CandidatesDecayResult {
  archived: number;
  durationMs: number;
}

export async function runCandidatesDecay(): Promise<CandidatesDecayResult> {
  const t0 = Date.now();

  const archivedRows = await db
    .update(memoryCandidates)
    .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        isNull(memoryCandidates.archivedAt),
        eq(memoryCandidates.status, 'accruing'),
        lt(memoryCandidates.createdAt, daysAgo(CANDIDATES_DECAY_DAYS)),
        sql`${memoryCandidates.confidence}::numeric < ${CANDIDATES_DECAY_CONFIDENCE_THRESHOLD}`,
      ),
    )
    .returning({ id: memoryCandidates.id });

  return { archived: archivedRows.length, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerCandidatesDecay(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(CANDIDATES_DECAY_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(CANDIDATES_DECAY_QUEUE, async () => {
    try {
      const result = await runCandidatesDecay();
      logger.info(result, 'candidates-decay: sweep complete');
    } catch (err) {
      logger.error({ err }, 'candidates-decay: sweep failed');
      throw err;
    }
  });
  // Daily, off-peak — offset from memory-decay (3:30) to avoid concurrent sweeps.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(CANDIDATES_DECAY_QUEUE, '45 3 * * *');
  registered = true;
}

export function resetCandidatesDecayForTest(): void {
  registered = false;
}
