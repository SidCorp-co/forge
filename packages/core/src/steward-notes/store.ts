/**
 * The steward notes table (`db/schema-steward-notes.ts`): the current note of each subject, and the
 * write that supersedes it in the same transaction, insert-only otherwise.
 */

import type {
  StandingSubject,
  StewardCite,
  StewardClaims,
  StewardNote,
  StewardNoteSubjectKind,
  StewardNoteWrite,
} from '@forge/contracts/steward';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { stewardNotes } from '../db/schema-steward-notes.js';
import { peopleOf } from '../lib/people.js';
import { factsVersion } from './ports.js';

type NoteRow = typeof stewardNotes.$inferSelect;

/** The current note of each of `subjectIds`, by subject id. */
export async function currentNoteRowsOf(
  projectId: string,
  subjectIds?: readonly string[],
): Promise<Map<string, NoteRow>> {
  if (subjectIds && subjectIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(stewardNotes)
    .where(
      and(
        eq(stewardNotes.projectId, projectId),
        isNull(stewardNotes.supersededAt),
        subjectIds ? inArray(stewardNotes.subjectId, [...subjectIds]) : undefined,
      ),
    );
  return new Map(rows.map((r) => [r.subjectId, r]));
}

/**
 * Rows as every page reads them; `basisOf` gives each subject's current basis, so a moved one reads
 * stale, as one written under facts core has since reworded does (ISS-1044): its words state what
 * the steward is no longer told, though the item's basis never moved.
 */
export async function notesOf(
  rows: readonly NoteRow[],
  keyOf: (row: NoteRow) => string,
  basisOf: (subjectId: string) => string | null,
): Promise<Map<string, StewardNote>> {
  const people = await peopleOf(rows.map((r) => r.writtenBy));
  const facts = rows.length > 0 ? factsVersion() : null;
  return new Map(
    rows.map((r) => {
      const who = people.get(r.writtenBy);
      const subject: StandingSubject<StewardNoteSubjectKind> = {
        kind: r.subjectKind,
        id: r.subjectId,
        key: keyOf(r),
      };
      return [
        r.subjectId,
        {
          subject,
          lines: r.lines,
          cites: r.cites as StewardCite[],
          claims: r.claims as StewardClaims,
          basis: r.basis,
          stale: basisOf(r.subjectId) !== r.basis || r.factsVersion !== facts,
          factsVersion: r.factsVersion,
          writtenAt: r.writtenAt.toISOString(),
          writtenBy: { id: r.writtenBy, name: who?.name ?? null, kind: who?.kind ?? 'human' },
          runId: r.runId,
        },
      ];
    }),
  );
}

/** Supersedes the subject's current note and inserts the new one, in one transaction. */
export async function writeNoteRow(input: {
  projectId: string;
  subject: StandingSubject<StewardNoteSubjectKind>;
  write: StewardNoteWrite;
  writtenBy: string;
}): Promise<NoteRow> {
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(stewardNotes)
      .set({ supersededAt: now })
      .where(
        and(
          eq(stewardNotes.subjectKind, input.subject.kind),
          eq(stewardNotes.subjectId, input.subject.id),
          isNull(stewardNotes.supersededAt),
        ),
      );
    const [row] = await tx
      .insert(stewardNotes)
      .values({
        projectId: input.projectId,
        subjectKind: input.subject.kind,
        subjectId: input.subject.id,
        lines: input.write.lines,
        cites: input.write.cites,
        claims: input.write.claims,
        basis: input.write.basis,
        writtenBy: input.writtenBy,
        runId: input.write.runId,
        factsVersion: factsVersion(),
        writtenAt: now,
      })
      .returning();
    if (!row) throw new Error(`steward notes: the insert for ${input.subject.key} returned no row`);
    return row;
  });
}
