import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';

export interface ReleaseRecordRefusal {
  detail: string;
  details: Record<string, unknown>;
}

export const RELEASE_RECORD_REMEDY =
  'Set `releaseNotes` first: `{ section, userFacing }` with the one plain-language line a ' +
  "user would read, or `{ section: 'Skip', userFacing: '-' }` when the change has no " +
  'user-facing half.';

/**
 * Which of these issues have no release note. The shared read behind both doors.
 */
export async function issuesMissingReleaseRecord(issueIds: string[]): Promise<string[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .select({ id: issues.id, releaseNotes: issues.releaseNotes })
    .from(issues)
    .where(inArray(issues.id, issueIds))
    .limit(issueIds.length);
  return rows.filter((r) => !r.releaseNotes).map((r) => r.id);
}
