import { z } from 'zod';

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

export const ReleaseNotesSchema = z
  .object({
    section: ReleaseNotesSectionSchema,
    // `min(1)` even for the Skip case: clients pass a single-char placeholder
    // (`'-'`) so the schema stays a simple object (no union on section).
    userFacing: z.string().min(1).max(500),
    technical: z.string().max(500).nullable().optional(),
  })
  .strict();
export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;
