// The criteria a release counts beyond the issues it carries (ISS-900): where production names no
// commit it serves, a criterion judged on a release belongs to that release and to every release its
// agent's record says carries it, whichever release shipped its issue.

import { versionsCountedOn } from '@forge/contracts/released-line';
import type { ReleaseCriterionView } from '@forge/contracts/releases';
import { voidedOnRelease } from './judged-before-reopen.js';
import { criteriaAt, type ReleaseFacts } from './release-facts.js';

/**
 * The criteria a release counts beyond the issues it carries (ISS-900): a criterion judged on release
 * 0.76.0 belongs to 0.76.0, and to every later release its record says carries 0.76.0, whichever
 * release shipped its issue. Each issue off `roster` holding such a verdict, with only its criteria
 * judged on a release this one counts (`versionsCountedOn`), read as `criteriaAt` reads them.
 */
export function judgedOnReleaseAt(
  facts: ReleaseFacts,
  roster: readonly string[],
  version: string,
): Array<{ key: string; title: string; criteria: ReleaseCriterionView[] }> {
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
    const judged = issue.criteria.filter(
      (c) =>
        (verdicts.get(c.n)?.length ?? 0) > 0 ||
        voidedOnRelease(issue, c.n, versions, facts.released, version).length > 0,
    );
    if (judged.length === 0) return [];
    const read = { ...issue, criteria: judged, verdicts };
    return [
      { key: issue.key, title: issue.title, criteria: criteriaAt(read, null, facts, version) },
    ];
  });
}
