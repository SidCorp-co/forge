import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';

export const DESKTOP_PAIRING_CLEANUP_QUEUE = 'desktop-pairing-cleanup';

const BATCH_SIZE = 10_000;

function deletedCount(result: unknown): number {
  const r = result as { count?: unknown; rowCount?: unknown } | null;
  if (typeof r?.count === 'number') return r.count;
  if (typeof r?.rowCount === 'number') return r.rowCount;
  return 0;
}

/**
 * Delete desktop_pairing_codes rows that are no longer useful:
 *   - expires_at in the past (anything past TTL, regardless of state)
 *   - consumed_at older than 1 day (kept briefly for log correlation)
 * Batched at 10k rows.
 */
export async function runDesktopPairingCleanup(): Promise<{
  deleted: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const result = await db.execute(sql`
      DELETE FROM desktop_pairing_codes
      WHERE id IN (
        SELECT id FROM desktop_pairing_codes
        WHERE expires_at < now()
           OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 day')
        LIMIT ${BATCH_SIZE}
      )
    `);
    const batch = deletedCount(result);
    total += batch;
    if (batch < BATCH_SIZE) break;
  }
  return { deleted: total, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerDesktopPairingCleanup(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(DESKTOP_PAIRING_CLEANUP_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(DESKTOP_PAIRING_CLEANUP_QUEUE, async () => {
    try {
      const result = await runDesktopPairingCleanup();
      logger.info(result, 'desktop-pairing-cleanup: sweep complete');
    } catch (err) {
      logger.error({ err }, 'desktop-pairing-cleanup: sweep failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(DESKTOP_PAIRING_CLEANUP_QUEUE, '15 * * * *');
  registered = true;
}

export function resetDesktopPairingCleanupForTest(): void {
  registered = false;
}
