// What a reopen leaves the releases that never shipped its fix (ISS-900: agenfold ISS-59 judged on a
// release version, 2026-11-02; and a release read by commit, whose build a fail was judged at). A
// reopen voids a failing criterion's verdicts for the issue's next round (`issues/release-evidence.ts:
// voidedUpTo`), so its fix is judged anew on the release that ships it. Until a release ships that
// round, every release that shipped before it still serves what the fail was judged on: it reads the
// verdicts judged on it, the fail included, or a release whose criterion failed on it would read that
// criterion unjudged, or every criterion proven (`VISION: state-never-lies`). From the release that
// ships the fix on, the void holds. One rule for both reads: by build and by release version.

import { judgedOnReleaseBuild } from '@forge/contracts/release-page';
import type { CarriedVerdict, IssueFact } from './release-facts.js';

/** The release a reopen's void is read against: when it shipped (null where it has not), and what it
 *  was judged on, its build and the versions it counts (`judgedOnReleaseBuild`). */
export interface VoidReader {
  shippedAt: Date | null | undefined;
  build: string | null;
  judgedOn: string | null;
  versions: ReadonlySet<string>;
}

/**
 * The verdicts a reopen voided on criterion `n` that a release still reads: those judged on that very
 * release, by build or by version, where it shipped before any release shipped the issue again after
 * the reopen. None on a release not shipped, on the one that ships the fix, or on any later one.
 */
export function voidedStillRead(
  issue: Pick<IssueFact, 'voided' | 'reopenedAt' | 'closedAt'>,
  n: number,
  { shippedAt, build, judgedOn, versions }: VoidReader,
): CarriedVerdict[] {
  const reopened = issue.reopenedAt?.getTime();
  if (!shippedAt || reopened === undefined) return [];
  const fixed = issue.closedAt.find((at) => at.getTime() > reopened);
  if (fixed && fixed.getTime() <= shippedAt.getTime()) return [];
  return (issue.voided.get(n) ?? []).filter((v) =>
    judgedOnReleaseBuild(v, build, judgedOn, versions),
  );
}
