import { db } from '../db/client.js';
import type { AdminThresholds } from '../db/schema-admin-thresholds.js';
import { ADMIN_THRESHOLDS_ID, adminThresholds } from '../db/schema-admin-thresholds.js';
import { readThresholds } from './read.js';

/** Merges `patch` over the stored thresholds and upserts the singleton; answers what is stored. */
export async function saveThresholds(
  patch: { [K in keyof AdminThresholds]?: AdminThresholds[K] | undefined },
  updatedBy: string,
) {
  const next = { ...(await readThresholds()), ...patch };
  await db
    .insert(adminThresholds)
    .values({ id: ADMIN_THRESHOLDS_ID, ...next, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: adminThresholds.id,
      set: { ...next, updatedBy, updatedAt: new Date() },
    });
  return next;
}
