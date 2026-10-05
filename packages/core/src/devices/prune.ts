import { sql } from 'drizzle-orm';
import { revokeDevices } from './service.js';

const PRUNE_DAYS = 30;

/** Boxes unseen for the prune window are revoked through the one revoke path, credentials included. */
export async function runDevicePrune(): Promise<{ revoked: number; durationMs: number }> {
  const t0 = Date.now();
  const days = PRUNE_DAYS;
  const revoked = await revokeDevices({
    where: sql`(last_seen_at IS NULL OR last_seen_at < now() - make_interval(days => ${days}))
      AND paired_at < now() - make_interval(days => ${days})`,
    reason: `unseen for ${days} days`,
    actor: { type: 'sweeper' },
    source: 'device-prune',
  });
  return { revoked: revoked.length, durationMs: Date.now() - t0 };
}
