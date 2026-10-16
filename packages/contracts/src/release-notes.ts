import { z } from "zod";

export const releaseNotesSections = [
  'Added',
  'Changed',
  'Fixed',
  'Removed',
  'Security',
  'Skip',
] as const;

export const ReleaseNotesSectionSchema = z.enum(releaseNotesSections);
export type ReleaseNotesSection = z.infer<typeof ReleaseNotesSectionSchema>;

/** The most words a change's short title says (REQ-40 BC-6): a reader scans it whole, never cut. */
export const RELEASE_NOTE_TITLE_WORDS_MAX = 10;
/** A title in a script written without spaces is held to this many characters instead. */
export const RELEASE_NOTE_TITLE_CHARS_MAX = 80;
/** The most admin steps one issue's note names (REQ-40 BC-7). */
export const RELEASE_NOTE_ADMIN_STEPS_MAX = 5;

const wordsIn = (text: string) => text.split(/\s+/u).filter(Boolean).length;

/**
 * An issue's release note as stored. `title` is the change's short name a reader scans; `userFacing`
 * the one sentence that says it in full; `adminSteps` what an admin must do before it goes out.
 * `title` and `adminSteps` are absent on a note written before they existed, which a reader shows
 * whole: its sentence is never cut into a title.
 */
export const ReleaseNotesSchema = z
  .object({
    section: ReleaseNotesSectionSchema,
    title: z.string().trim().min(1).max(RELEASE_NOTE_TITLE_CHARS_MAX).optional(),
    // `min(1)` even for the Skip case: clients pass a single-char placeholder
    // (`'-'`) so the schema stays a simple object (no union on section).
    userFacing: z.string().min(1).max(500),
    technical: z.string().max(500).nullable().optional(),
    adminSteps: z
      .array(z.string().trim().min(1).max(200))
      .max(RELEASE_NOTE_ADMIN_STEPS_MAX)
      .optional(),
  })
  .strict();
export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;

/**
 * A release note as it is written (REQ-40 BC-17): every note a user reads carries its short title,
 * of at most `RELEASE_NOTE_TITLE_WORDS_MAX` words. A note without one is refused here, at the step
 * that writes it, naming the field; a reader never truncates a sentence to make one.
 */
export const ReleaseNotesWriteSchema = ReleaseNotesSchema.superRefine((note, ctx) => {
  if (note.section === 'Skip') return;
  if (note.title === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['title'],
      message: `title is required for a ${note.section} note: a short title of at most ${RELEASE_NOTE_TITLE_WORDS_MAX} words a user scans, with userFacing as its one full sentence. Send {"releaseNotes":{"section":"${note.section}","title":"<at most ${RELEASE_NOTE_TITLE_WORDS_MAX} words>","userFacing":"<its one full sentence>"}}.`,
    });
    return;
  }
  const words = wordsIn(note.title);
  if (words > RELEASE_NOTE_TITLE_WORDS_MAX) {
    ctx.addIssue({
      code: 'custom',
      path: ['title'],
      message: `title has ${words} words; a title is at most ${RELEASE_NOTE_TITLE_WORDS_MAX}, and the rest belongs in userFacing.`,
    });
  }
});

/** The most words a release's name says (REQ-40 BC-14): "ePOD deploy", never a list of its changes. */
export const RELEASE_NAME_WORDS_MAX = 6;
export const RELEASE_NAME_CHARS_MAX = 60;
/** A release's summary is two or three sentences (REQ-40 BC-14). */
export const RELEASE_SUMMARY_SENTENCES = { min: 2, max: 3 } as const;
export const RELEASE_SUMMARY_CHARS_MAX = 600;

/** Sentences in `text`: each ends at a full stop, question or exclamation mark, in any script. */
export function sentencesIn(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?。！？])\s+|(?<=[。！？])/u)
    .filter((s) => /[\p{L}\p{N}]/u.test(s)).length;
}

/**
 * A release's name and summary, written by whoever cuts it (REQ-40 BC-14). Each is refused by name
 * where it breaks its rule: a name is a few words, a summary two or three whole sentences.
 */
export const ReleaseNamingSchema = z
  .object({
    name: z.string().trim().min(1).max(RELEASE_NAME_CHARS_MAX),
    summary: z.string().trim().min(1).max(RELEASE_SUMMARY_CHARS_MAX),
  })
  .strict()
  .superRefine((v, ctx) => {
    const words = wordsIn(v.name);
    if (words > RELEASE_NAME_WORDS_MAX)
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: `name has ${words} words; a release name is at most ${RELEASE_NAME_WORDS_MAX}, and what it brings belongs in summary.`,
      });
    const n = sentencesIn(v.summary);
    const { min, max } = RELEASE_SUMMARY_SENTENCES;
    if (n < min || n > max)
      ctx.addIssue({
        code: 'custom',
        path: ['summary'],
        message: `summary has ${n} sentence${n === 1 ? '' : 's'}; it is ${min} to ${max} sentences saying what the release brings its users.`,
      });
  });
export type ReleaseNaming = z.infer<typeof ReleaseNamingSchema>;
