// A holder's close reads the issue's release note (ISS-1293, FB-716). The release that carries an
// issue reads its note, and the close is the holder's last act on it: a close over a note the door
// refused (`PATCH /api/issues/:id` judges it by `ReleaseNotesWriteSchema` and stores nothing) or
// never wrote left `closed` saying done while the release had nothing to say. Kernel input: refused
// by name, never drafted here.
//
// Asked only on the holder's close (`close-in-scope.ts:inScopeGuard`, past its holder check). A
// release's close is not asked: the door that cuts or records it drafts a missing note outside strict
// and refuses one under strict before it claims anything (`release-batch/blockers.ts:admitRoster`), so
// no release is wedged here. A design-only, adoption-only or owed-filing close ships nothing of its
// own, and the way back from a requirement-level fail's reopen restores a close already made.

import { RELEASE_NOTE_TITLE_WORDS_MAX, releaseNotesSections } from '@forge/contracts/release-notes';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { mergeNotRecorded } from './merged-at.js';
import type { GuardContext, GuardFault } from './transition-guards.js';

/** The sections a note a user reads goes under: every one but `Skip`. */
const READ_SECTIONS = releaseNotesSections.filter((s) => s !== 'Skip');

/** Whether the issue holds a release note: a stored JSON `null` is the note's absence too. */
async function hasReleaseNote(executor: Pick<Tx, 'execute'>, issueId: string): Promise<boolean> {
  const rows = (await executor.execute(sql`
    SELECT release_notes IS NOT NULL AND release_notes <> 'null'::jsonb AS noted
      FROM issues WHERE id = ${issueId}::uuid`)) as unknown as Array<{ noted: boolean }>;
  return rows[0]?.noted === true;
}

/**
 * The holder's close of an issue that ships, refused while no release note stands on it. A close the
 * `merged` guard refuses (no landing recorded, or an adoption record that no longer holds) is left to
 * it: that guard runs next on the edge, and a close with nothing landed is told that first.
 */
export async function closeNoteFault(ctx: GuardContext, tx: Tx): Promise<GuardFault | null> {
  if (await hasReleaseNote(tx, ctx.issue.id)) return null;
  if (await mergeNotRecorded(tx, { issueId: ctx.issue.id, to: 'closed' })) return null;
  const door = `PATCH /api/issues/${ctx.issue.id}`;
  return {
    code: 'CLOSE_RELEASE_NOTE_MISSING',
    detail: `the release that carries this issue reads its release note, and none is recorded on it: a note write the door refused stored nothing. Write it with \`${door}\` \`{"releaseNotes":{"section":"<${READ_SECTIONS.join('|')}>","title":"<at most ${RELEASE_NOTE_TITLE_WORDS_MAX} words>","userFacing":"<one full sentence>"}}\`, or \`{"releaseNotes":{"section":"Skip","userFacing":"-"}}\` for a change no user reads; read it back with \`GET /api/issues/${ctx.issue.id}\`, then close.`,
    details: {
      from: ctx.from,
      to: ctx.to,
      door,
      field: 'releaseNotes',
      sections: releaseNotesSections,
    },
  };
}
