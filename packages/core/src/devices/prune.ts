import { sql } from 'drizzle-orm';
import { revokeDevices } from './service.js';

function pruneDays(): number {
  const raw = Number.parseInt(process.env.DEVICE_PRUNE_DAYS ?? '', 10);
  return Number.isFinite(raw) && raw >= 7 ? raw : 30;
}

/** Boxes unseen for the prune window are revoked through the one revoke path, credentials included. */
export async function runDevicePrune(): Promise<{ revoked: number; durationMs: number }> {
  const t0 = Date.now();
  const days = pruneDays();
  const revoked = await revokeDevices({
    where: sql`(last_seen_at IS NULL OR last_seen_at < now() - make_interval(days => ${days}))
      AND paired_at < now() - make_interval(days => ${days})`,
    reason: `unseen for ${days} days`,
    actor: { type: 'sweeper' },
    source: 'device-prune',
  });
  return { revoked: revoked.length, durationMs: Date.now() - t0 };
}
