import {
  contentLanguageScriptWarning,
  releaseNoteReferenceWarning,
} from '@forge/contracts/content-language';
import { type ReleaseNotes, ReleaseNotesWriteSchema } from '@forge/contracts/release-notes';
import { jsonPointer, type Refusal, RefusalError } from '../lib/refusal.js';
import { readProjectDocument } from './ports.js';

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

/**
 * What a stored note answers its writer, the same at every door that writes one (ISS-1099): each of
 * its title, sentence and admin steps whose letters disagree with the project's content language, in
 * either direction (`contentLanguageScriptWarning`), and each engineer's reference its title and
 * sentence carry (`releaseNoteReferenceWarning`). A `Skip` note is read by no user and answers none.
 * Warnings only: the note was stored as sent (owner 2026-11-05, teach and never block).
 */
export async function releaseNoteWarnings(
  projectId: string,
  note: ReleaseNotes | null | undefined,
): Promise<string[]> {
  if (!note || note.section === 'Skip') return [];
  const language = (await readProjectDocument(projectId))?.document.contentLanguage ?? 'en';
  const shown: [string, string][] = [
    ...(note.title ? [[note.title, 'releaseNotes.title'] as [string, string]] : []),
    [note.userFacing, 'releaseNotes.userFacing'],
  ];
  const steps = (note.adminSteps ?? []).map(
    (step, i) => [step, `releaseNotes.adminSteps[${i}]`] as [string, string],
  );
  return [
    ...[...shown, ...steps].flatMap(([text, field]) => {
      const mismatch = contentLanguageScriptWarning(language, text, field);
      return mismatch ? [mismatch] : [];
    }),
    ...shown.flatMap(([text, field]) => {
      const references = releaseNoteReferenceWarning(text, field);
      return references ? [references] : [];
    }),
  ];
}
