import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';

export const DEVICE_PRUNE_QUEUE = 'device-offline-prune';

function pruneDays(): number {
  const raw = Number.parseInt(process.env.DEVICE_PRUNE_DAYS ?? '', 10);
  return Number.isFinite(raw) && raw >= 7 ? raw : 30;
}

type PrunedRow = { id: string };

export async function runDevicePrune(): Promise<{ revoked: number; durationMs: number }> {
  const t0 = Date.now();
  const days = pruneDays();
  const revoked = await db.transaction(async (tx) => {
    const rows = await tx.execute<PrunedRow>(sql`
      UPDATE devices
      SET status = 'revoked'
      WHERE status <> 'revoked'
        AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(days => ${days}))
        AND paired_at < now() - make_interval(days => ${days})
      RETURNING id
    `);
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await tx.delete(runners).where(inArray(runners.deviceId, ids));
    }
    return ids.length;
  });

  return { revoked, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerDevicePrune(): Promise<void> {
  if (registered) return;
  // pg-boss v10 requires explicit createQueue before schedule/work can reference it.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(DEVICE_PRUNE_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(DEVICE_PRUNE_QUEUE, async () => {
    try {
      const result = await runDevicePrune();
      logger.info(result, 'device-offline-prune: sweep complete');
    } catch (err) {
      logger.error({ err }, 'device-offline-prune: sweep failed');
      throw err;
    }
  });
  // Daily at 04:00 (after the 03:00 retention sweep).
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(DEVICE_PRUNE_QUEUE, '0 4 * * *');
  registered = true;
}

export function resetDevicePruneForTest(): void {
  registered = false;
}
