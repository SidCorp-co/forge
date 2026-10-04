import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';

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
