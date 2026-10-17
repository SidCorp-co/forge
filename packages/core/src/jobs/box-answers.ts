import { type SQL, sql } from 'drizzle-orm';

/** Three missed runner heartbeats, the silence after which the device stale detector calls a box offline. */
export const BOX_SILENT_AFTER_MS = 90_000;

export function boxAnswersSql(deviceId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM runners ba
     WHERE ba.device_id = ${deviceId}
       AND ba.last_seen_at > now() - make_interval(secs => ${BOX_SILENT_AFTER_MS / 1000})
  )`;
}
