import { ReleaseNotesSectionSchema } from '@forge/contracts/release-notes';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';

/** A stored note whose section the cut cannot place: the section it holds, null where it holds none. */
export interface UnplaceableReleaseNote {
  id: string;
  section: string | null;
}

/**
 * What a release roster owes its notes: the issues with none, and the issues holding one whose
 * section is not an accepted one (ISS-835), which a release would otherwise carry into no section
 * at all. The shared read behind both doors.
 */
export async function releaseRecordGaps(
  issueIds: string[],
): Promise<{ missing: string[]; unplaceable: UnplaceableReleaseNote[] }> {
  if (issueIds.length === 0) return { missing: [], unplaceable: [] };
  const rows = await db
    .select({ id: issues.id, releaseNotes: issues.releaseNotes })
    .from(issues)
    .where(inArray(issues.id, issueIds))
    .limit(issueIds.length);
  const unplaceable: UnplaceableReleaseNote[] = [];
  for (const r of rows) {
    if (!r.releaseNotes) continue;
    const section = (r.releaseNotes as { section?: unknown }).section;
    if (!ReleaseNotesSectionSchema.safeParse(section).success) {
      unplaceable.push({ id: r.id, section: typeof section === 'string' ? section : null });
    }
  }
  return { missing: rows.filter((r) => !r.releaseNotes).map((r) => r.id), unplaceable };
}
