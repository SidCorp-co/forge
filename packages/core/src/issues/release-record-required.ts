import { type ReleaseNotes, ReleaseNotesSectionSchema } from '@forge/contracts/release-notes';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memoizedPerId } from '../db/read-memo.js';
import { issues } from '../db/schema.js';

/** A stored note whose section the cut cannot place: the section it holds, null where it holds none. */
export interface UnplaceableReleaseNote {
  id: string;
  section: string | null;
}

/**
 * Each named issue's stored release note, by its id in lower case, in the order asked; none for an
 * issue not held. An issue's note is its own: every ask of a read, a roster's gaps or who owes its
 * release acts (`release-batch/release-owes.ts:readReleaseOwes`), and every project's, is one statement
 * (`db/read-memo.ts:memoizedPerId`, ISS-1070 r12; one key for both since r21, which read it twice).
 */
export function releaseNotesOf(
  issueIds: readonly string[],
): Promise<Map<string, { id: string; releaseNotes: ReleaseNotes | null }>> {
  return memoizedPerId(
    'releaseNotesOf',
    [...new Set(issueIds.map((id) => id.toLowerCase()))],
    async (some) => {
      const read = await db
        .select({ id: issues.id, releaseNotes: issues.releaseNotes })
        .from(issues)
        .where(inArray(issues.id, [...some]));
      return new Map(read.map((r) => [r.id.toLowerCase(), r]));
    },
  );
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
  const rows = [...(await releaseNotesOf(issueIds)).values()];
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
