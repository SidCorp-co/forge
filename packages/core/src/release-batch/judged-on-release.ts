// The criteria a release counts beyond the issues it carries (ISS-900): where production names no
// commit it serves, a criterion judged on a release belongs to that release and to every release its
// agent's record says carries it, whichever release shipped its issue.

import { versionsCountedOn } from '@forge/contracts/released-line';
import { type CriterionReading, criterionReadingsAt } from './criterion-reading.js';
import { voidedStillRead } from './judged-before-reopen.js';
import type { IssueFact, ReleaseFacts } from './release-facts.js';

/**
 * The criteria a release counts beyond the issues it carries (ISS-900): a criterion judged on release
 * 0.76.0 belongs to 0.76.0, and to every later release its record says carries 0.76.0, whichever
 * release shipped its issue. Each issue off `roster` holding such a verdict, with only its criteria
 * judged on a release this one counts (`versionsCountedOn`), read as `criterionReadingsAt` reads them.
 */
export function judgedOnReleaseAt(
  facts: ReleaseFacts,
  roster: readonly string[],
  version: string,
): Array<{ issue: IssueFact; readings: CriterionReading[] }> {
  const versions = versionsCountedOn(facts.released, version);
  return facts.judgedOnRelease.flatMap((id) => {
    const issue = facts.issues.get(id);
    if (!issue || roster.includes(id)) return [];
    const verdicts = new Map(
      [...issue.verdicts].map(([n, vs]) => [
        n,
        vs.filter((v) => v.identityKind === 'release' && versions.has(v.releaseVersion ?? '')),
      ]),
    );
    // a fail judged on this release before the reopen it caused is still this release's (ISS-59)
    const reader = {
      shippedAt: facts.released?.shipped.get(version)?.at,
      build: null,
      judgedOn: facts.judgedOn,
      versions,
    };
    const judged = issue.criteria.filter(
      (c) => (verdicts.get(c.n)?.length ?? 0) > 0 || voidedStillRead(issue, c.n, reader).length > 0,
    );
    if (judged.length === 0) return [];
    const read = { ...issue, criteria: judged, verdicts };
    return [{ issue, readings: criterionReadingsAt(read, null, facts, version) }];
  });
}
