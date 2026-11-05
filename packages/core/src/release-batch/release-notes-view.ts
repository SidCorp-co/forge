// A release's notes as its record shows them, projected from its issues' release notes: pure, no I/O.

import { releaseNoteAttention } from '@forge/contracts/content-language';
import { releaseNotesSections } from '@forge/contracts/release-notes';
import type {
  IssueLandingReading,
  ReleaseNoteEntry,
  ReleaseNoteSection,
} from '@forge/contracts/releases';
import { reworkedSince } from '../issues/index.js';
import { gapOf, surfacesOf } from './landing-surfaces.js';
import type { IssueFact } from './release-facts.js';
import type { Part, Shared } from './release-read-views.js';

const CHANGELOG_SECTIONS = releaseNotesSections.filter((s) => s !== 'Skip');

const noteEntry = (i: IssueFact): ReleaseNoteEntry => ({
  key: i.key,
  title: i.title,
  heading: i.releaseNotes?.title?.trim() || null,
  userFacing: i.releaseNotes?.userFacing ?? '',
  technical: i.releaseNotes?.technical ?? null,
  adminSteps: i.releaseNotes?.adminSteps ?? [],
});

/** A landing that names the design surface and nothing else: an approved design, not a user change. */
const designOnly = (reading: IssueLandingReading | undefined): boolean => {
  if (!reading) return false;
  const surfaces = surfacesOf(reading);
  return surfaces.length > 0 && surfaces.every((x) => x === 'design') && gapOf(reading) === null;
};

// what users get leaves out an issue whose landing only touched a design: it lists under the
// approved designs instead (JU-11), so a design review is never read as a change people use
export function noteSections(
  p: Pick<Part, 'issueIds' | 'openedAt' | 'releasedAt'>,
  s: Pick<Shared, 'facts' | 'contentLanguage'>,
  landings: ReadonlyMap<string, IssueLandingReading>,
) {
  const claimed = p.issueIds.flatMap((id) => s.facts.issues.get(id) ?? []);
  const reworked = claimed.filter((i) => reworkedSince(p, i));
  const all = claimed.filter((i) => !reworked.includes(i));
  const designs = all.filter((i) => designOnly(landings.get(i.id)));
  const facts = all.filter((i) => !designs.includes(i));
  const sections: ReleaseNoteSection[] = CHANGELOG_SECTIONS.map((section) => ({
    section,
    entries: facts.filter((i) => i.releaseNotes?.section === section).map(noteEntry),
  })).filter((x) => x.entries.length > 0);
  // a reader aid on the draft, not a gate: the release gate's own reasons are unchanged
  const attention = facts.flatMap((i) => {
    if (!i.releaseNotes || i.releaseNotes.section === 'Skip') return [];
    const found = releaseNoteAttention(s.contentLanguage, i.releaseNotes.userFacing);
    return found.notInLanguage || found.references.length > 0
      ? [{ key: i.key, title: i.title, ...found }]
      : [];
  });
  return {
    sections,
    designs: designs.map(noteEntry),
    withoutNotes: facts.filter((i) => !i.releaseNotes).map((i) => ({ key: i.key, title: i.title })),
    skipped: facts.filter((i) => i.releaseNotes?.section === 'Skip').map(noteEntry),
    reworked: reworked.map((i) => ({ key: i.key, title: i.title })),
    language: s.contentLanguage,
    attention,
  };
}
