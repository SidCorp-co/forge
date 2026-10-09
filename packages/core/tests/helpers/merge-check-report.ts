/**
 * A passing merge check report, typed against the contract the route parses
 * (`@forge/contracts/merge-check`, `@forge/contracts/check-runs`). Every suite that posts one builds
 * it here, so a change to the report's shape fails the typecheck of the branch that makes it rather
 * than the release cut's whole integration suite (ISS-489 r5: ISS-474 added `id`, `kind` and
 * `startedAt` to each check and a hand-built report elsewhere kept being refused BAD_REQUEST).
 */

import { randomUUID } from 'node:crypto';
import type { CheckRun } from '@forge/contracts/check-runs';
import {
  MERGE_CHECK_KINDS,
  type MergeCheckReport,
  REQUIRED_MERGE_CHECKS,
  type RequiredMergeCheck,
} from '@forge/contracts/merge-check';

/** One required check, passed, with an id of its own so no two reports share one. */
export function passingCheck(name: RequiredMergeCheck): CheckRun {
  return {
    id: randomUUID(),
    kind: MERGE_CHECK_KINDS[name],
    startedAt: '2026-10-09T06:00:00.000Z',
    name,
    scope: 'workspace',
    command: `run ${name}`,
    files: [],
    result: 'pass',
    durationMs: 1200,
  };
}

/** Every check a merge needs, each passed. */
export function passingChecks(): CheckRun[] {
  return REQUIRED_MERGE_CHECKS.map((name) => passingCheck(name));
}

/** A report whose every required check passed, over `touched`, at `head` on `base`. */
export function passingReport(
  at: Pick<MergeCheckReport, 'base' | 'head' | 'touched'> & Partial<MergeCheckReport>,
): MergeCheckReport {
  return { mode: 'pre-merge', checks: passingChecks(), ...at };
}
