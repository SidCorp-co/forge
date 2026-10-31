import { ReleaseNotesWriteSchema } from '@forge/contracts/release-notes';
import { jsonPointer, type Refusal, RefusalError } from '../lib/refusal.js';

/**
 * A release note a door is about to store, judged as `PATCH /api/issues/:id` judges it
 * (`request-schemas.ts:issuePatchSchema`): one check, so no door stores what another refuses. An
 * unknown section is refused by name at its path with the accepted ones, and nothing is stored
 * (ISS-835). `null` is the note's absence, which every door may write.
 */
export function refuseBadReleaseNote(note: unknown): void {
  if (note === null || note === undefined) return;
  const result = ReleaseNotesWriteSchema.safeParse(note);
  if (result.success) return;
  const refusals: Refusal[] = result.error.issues.map((i) => ({
    code: 'RELEASE_NOTE_REFUSED',
    path: jsonPointer(['releaseNotes', ...i.path]),
    detail: i.message,
  }));
  throw new RefusalError(refusals, 'ISSUE_CREATE_REFUSED');
}
