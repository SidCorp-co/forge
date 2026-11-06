// What a composed prompt or orientation carried, for the record of what reached a run (ISS-1065):
// each always-applied rule whose text it holds, and each lesson its map names. Read off the composed
// text itself, so the record is of what the agent was given, not of what the store held.

import type { RunContextSource } from '@forge/contracts/run-context';
import {
  type AlwaysInjectFact,
  type LessonEntry,
  selectAlwaysInjectFromKnowledge,
  selectLessonEntries,
} from '../knowledge/index.js';
import { digestOf } from '../run-context/index.js';
import { checkoutOrientation } from './checkout-orientation.js';

/** The rules and lessons `text` carried, each at the version of the text it was given. */
export function carriedIn(
  text: string,
  rules: readonly AlwaysInjectFact[],
  lessons: readonly LessonEntry[],
): RunContextSource[] {
  return [
    ...rules
      .filter((r) => text.includes(r.text))
      .map((r) => ({ kind: 'rule' as const, ref: r.key, revision: digestOf(r.text) })),
    // the lessons map names a lesson as `<slug> [<scope>]` (`lessons/block.ts:lessonsMapText`), and
    // names only as many as fit; the rest it counts, and a lesson only counted did not reach the run
    ...lessons
      .filter((l) => text.includes(`${l.slug} [`))
      .map((l) => ({ kind: 'lesson' as const, ref: l.slug, revision: digestOf(l.sentence) })),
  ];
}

/**
 * The rules and lessons the orientation core serves for the project carries now: what a run a master
 * declares in a checkout of it is given. A knowledge store that cannot be read throws, and the
 * recorder counts it as a reach it could not record.
 */
export async function orientationCarried(projectId: string): Promise<RunContextSource[]> {
  const [entries, lessons] = await Promise.all([
    selectAlwaysInjectFromKnowledge(projectId),
    selectLessonEntries(projectId),
  ]);
  return carriedIn(checkoutOrientation(projectId, '', { entries, lessons }), entries, lessons);
}
