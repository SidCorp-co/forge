import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type ReleaseAttemptRow, releaseAttempts } from '../db/schema-release-ledger.js';

export type { ReleaseAttemptRow };

/** Every attempt of one run, oldest first. */
export async function listAttempts(runId: string): Promise<ReleaseAttemptRow[]> {
  return db
    .select()
    .from(releaseAttempts)
    .where(eq(releaseAttempts.runId, runId))
    .orderBy(asc(releaseAttempts.startedAt), asc(releaseAttempts.id));
}
