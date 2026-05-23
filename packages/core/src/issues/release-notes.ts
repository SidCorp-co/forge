import { z } from 'zod';

// ISS-199 — user-facing release notes attached to each issue. Written by
// forge-clarify when the issue is well-understood, read by forge-release at
// close time to append a bullet under the matching `### <section>` heading
// inside `## [Unreleased]` of `CHANGELOG.md`. The `forge-cut-release` skill
// later promotes `[Unreleased]` to a tagged version block.
//
// Stored as jsonb in `issues.release_notes`. Shape is enforced at the
// application layer rather than via a CHECK constraint so the enum can grow
// (e.g. `Deprecated` per Keep-a-Changelog) without a migration.

export const releaseNotesSections = [
  'Added',
  'Changed',
  'Fixed',
  'Removed',
  'Security',
  // `Skip` flags issues that have no user-facing summary (internal-only
  // refactors, infra-only changes). forge-release short-circuits on this
  // section so no CHANGELOG bullet is emitted.
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
