/**
 * The steward note door's one function for both doors (REQ-48 BC-7, BC-8): read a subject's current
 * note, or write one after the vet, as the project's steward or a person holding project.write (an
 * override, BC-12). A write that fails the vet changes nothing and names the field it was about.
 */

import type {
  ItemStanding,
  StewardNote,
  StewardNoteSubjectKind,
  StewardNoteWrite,
  StewardRefusalCode,
} from '@forge/contracts/steward';
import type { ProjectAccess } from '../lib/authz.js';
import { RefusalError, refuser } from '../lib/refusal.js';
import { holds } from '../permissions/index.js';
import { standingOf, unknownCites } from './ports.js';
import { currentNoteRowsOf, notesOf, writeNoteRow } from './store.js';
import { vetNote } from './vet.js';

const refuse = refuser<StewardRefusalCode>('STEWARD_NOTE_CONTRADICTS');

async function subjectStanding(
  projectId: string,
  kind: StewardNoteSubjectKind,
  key: string,
): Promise<ItemStanding> {
  const standing = await standingOf(projectId, kind, key);
  if (!standing) {
    throw refuse(
      'STEWARD_NOTE_SUBJECT_UNKNOWN',
      `${key} names no ${kind} of this project.`,
      '/key',
    );
  }
  return standing;
}

/** The subject's current note, marked stale where its standing moved since; null where none was written. */
export async function readStewardNote(
  projectId: string,
  kind: StewardNoteSubjectKind,
  key: string,
): Promise<{ note: StewardNote | null; standing: ItemStanding }> {
  const standing = await subjectStanding(projectId, kind, key);
  const rows = await currentNoteRowsOf(projectId, [standing.subject.id]);
  const notes = await notesOf(
    [...rows.values()],
    () => standing.subject.key,
    () => standing.basis,
  );
  return { note: notes.get(standing.subject.id) ?? null, standing };
}

/** Writes the note once the vet passes; the writer holds project.write or is refused by name. */
export async function writeStewardNote(input: {
  projectId: string;
  kind: StewardNoteSubjectKind;
  key: string;
  write: StewardNoteWrite;
  userId: string;
  access: ProjectAccess | null;
}): Promise<StewardNote> {
  if (!input.access || !holds(input.access, 'project.write')) {
    throw refuse(
      'STEWARD_NOTE_FORBIDDEN',
      'a steward note is written by the project steward or a person holding project.write.',
    );
  }
  const standing = await subjectStanding(input.projectId, input.kind, input.key);
  const refusals = vetNote(
    input.write,
    standing,
    await unknownCites(input.projectId, input.write.cites),
  );
  const [first] = refusals;
  if (first) throw new RefusalError(refusals, first.code);
  const row = await writeNoteRow({
    projectId: input.projectId,
    subject: { kind: input.kind, id: standing.subject.id, key: standing.subject.key },
    write: input.write,
    writtenBy: input.userId,
  });
  const notes = await notesOf(
    [row],
    () => standing.subject.key,
    () => standing.basis,
  );
  const note = notes.get(standing.subject.id);
  if (!note) throw new Error(`steward notes: the note written on ${input.key} was not read back`);
  return note;
}
