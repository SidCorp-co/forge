// What a reopen leaves the releases that never shipped its fix (ISS-900, agenfold ISS-59, 2026-11-02).
// A reopen voids a failing criterion's verdicts for the issue's next round (`issues/release-evidence.ts:
// voidedUpTo`), so its fix is judged anew on the release that ships it. Until a release ships that
// round, every release the record carries still serves what the fail was judged on: it reads the fail,
// or a release whose criterion failed on it would read every criterion proven (`VISION:
// state-never-lies`). From the release that ships the fix on, the void holds.

import type { ReleasedLine } from '@forge/contracts/released-line';
import type { CarriedVerdict, IssueFact } from './release-facts.js';

/**
 * The verdicts a reopen voided on criterion `n` that release `version` still reads: those judged on a
 * release it counts (`versions`), where `version` shipped before any release shipped the issue again
 * after its reopen. None on the release that ships the fix or any later, nor where the record does not
 * place `version`.
 */
export function voidedOnRelease(
  issue: Pick<IssueFact, 'voided' | 'reopenedAt' | 'closedAt'>,
  n: number,
  versions: ReadonlySet<string>,
  released: ReleasedLine | null | undefined,
  version: string | null,
): CarriedVerdict[] {
  const shipped = version === null ? undefined : released?.shipped.get(version)?.at;
  const reopened = issue.reopenedAt?.getTime();
  if (!shipped || reopened === undefined) return [];
  const fixed = issue.closedAt.find((at) => at.getTime() > reopened);
  if (fixed && fixed.getTime() <= shipped.getTime()) return [];
  return (issue.voided.get(n) ?? []).filter(
    (v) => v.identityKind === 'release' && versions.has(v.releaseVersion ?? ''),
  );
}
