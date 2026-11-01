// A release note drafted where none was written (REQ-79 r6 BC-12, BC-16; owner ruling 2026-10-31):
// outside strict a release never waits on a note. The door that cuts or records a release drafts each
// missing one from its issue — the title as its one sentence, the section from its category — and a
// stored note whose section no release can place is given the drafted section, its words kept. A
// draft carries no short title, so `release-batch/queries.ts:warnedReleaseNotes` names it to the master, who fills it
// in while the release runs; it stays off the release page until then. Under strict nothing is drafted
// and the missing note is refused RELEASE_RECORD_MISSING (`release-batch/record-blocker.ts`).

import { releaseNotesSections } from '@forge/contracts/release-notes';
import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { logger } from '../lib/logger.js';

const PLACEABLE = sql.raw(releaseNotesSections.map((s) => `'${s}'`).join(', '));

/** Draft the note of each named issue that has none, or holds one no release can place; answers the ids drafted. */
export async function draftMissingReleaseNotes(
  projectId: string,
  issueIds: readonly string[],
): Promise<string[]> {
  if (issueIds.length === 0) return [];
  const drafted = await db
    .update(issues)
    .set({
      releaseNotes: sql`CASE
        WHEN ${issues.releaseNotes} IS NULL OR ${issues.releaseNotes} = 'null'::jsonb
          THEN jsonb_build_object('section', ${draftSectionSql()}, 'userFacing', coalesce(nullif(btrim(${issues.title}), ''), 'Changed'))
        ELSE jsonb_set(${issues.releaseNotes}, '{section}', to_jsonb(${draftSectionSql()}))
      END`,
    })
    .where(
      and(
        sql`${issues.projectId} = ${projectId}`,
        inArray(issues.id, [...issueIds]),
        sql`(${issues.releaseNotes} IS NULL OR ${issues.releaseNotes} = 'null'::jsonb
             OR coalesce(${issues.releaseNotes} ->> 'section', '') NOT IN (${PLACEABLE}))`,
      ),
    )
    .returning({ id: issues.id });
  const ids = drafted.map((d) => d.id);
  if (ids.length > 0) {
    logger.info(
      { projectId, issueIds: ids },
      'release: drafted the release note of issues that had none it could place, for the master to fill in',
    );
  }
  return ids;
}

/** The section a drafted note goes under: a fix for a bug, an addition for a feature, else a change. */
function draftSectionSql() {
  return sql<string>`CASE ${issues.category} WHEN 'bug' THEN 'Fixed' WHEN 'feature' THEN 'Added' ELSE 'Changed' END`;
}
