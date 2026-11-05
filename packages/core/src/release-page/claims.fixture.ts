// The carried criteria the page's claims are read over, weighed as the release record weighs them
// (`release-batch/criterion-reading.ts:criterionReadingsAt`, ISS-1001), for the claims tests.

import type { CriterionClass } from '@forge/contracts/issue-design';
import type { PolicyQaMode } from '@forge/contracts/project-config';
import { criterionReadingsAt } from '../release-batch/criterion-reading.js';
import type { IssueFact } from '../release-batch/release-facts.js';
import {
  type CarriedCriterion,
  type CarriedVerdict,
  type ClaimReading,
  claimsOf,
} from './claims.js';

export const BUILD = 'a'.repeat(40);
export const MERGED = 'b'.repeat(40);

let seq = 0;
export function verdict(
  v: CarriedVerdict['verdict'],
  commitSha: string | null,
  at: string,
  extra: Partial<CarriedVerdict> = {},
): CarriedVerdict {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    criterionId: 'c',
    agency: 'agent',
    verdict: v,
    identityKind: commitSha ? 'commit' : null,
    commitSha,
    runtimeRef: null,
    at,
    reason: null,
    evidence: [],
    byBuilder: false,
    authored: true,
    recordedAt: at,
    ...extra,
  };
}

/** One carried criterion with every verdict it earned, its class and its issue's last reopen. */
export interface Carried extends CarriedCriterion {
  class: CriterionClass | null;
  reopenedAt: string | null;
  verdicts: CarriedVerdict[];
}

export function criterion(n: number, bc: string | null, verdicts: CarriedVerdict[]): Carried {
  return {
    issueId: 'issue-1',
    issueKey: 'ISS-1',
    requirementKey: bc ? 'REQ-1' : null,
    n,
    statement: `criterion ${n}`,
    bc,
    class: null,
    reopenedAt: null,
    verdicts,
  };
}

/** Each criterion as its own issue, as `loadReleaseFacts` hands it to the release record. */
function factOf(c: Carried): IssueFact {
  return {
    id: c.issueId,
    key: c.issueKey,
    title: c.issueKey,
    status: 'awaiting_release',
    updatedAt: new Date(0),
    releaseNotes: null,
    requirementId: null,
    criteria: [
      {
        n: c.n,
        statement: c.statement,
        standing: c.verdicts.at(-1)?.verdict ?? 'unjudged',
        bc: c.bc,
        identity: null,
        reason: null,
        judgedAt: null,
        judgedBy: null,
        proven: false,
        unverified: null,
      },
    ],
    classes: c.class ? new Map([[c.n, c.class]]) : new Map(),
    verdicts: new Map([[c.n, c.verdicts]]),
    voided: new Map(),
    reopenedAt: c.reopenedAt ? new Date(c.reopenedAt) : null,
    closedAt: [],
    merged: { at: null, landing: null, artifacts: null, commitSha: null, readPaths: null },
  };
}

/** The page's claims over `criteria`, weighed as the release record weighs them at `build`. */
export function readClaims(
  criteria: readonly Carried[],
  build: string | null,
  judge: PolicyQaMode | null,
  judgedOn: string | null,
  versions: ReadonlySet<string> = new Set(),
): ClaimReading[] {
  const version = [...versions][0] ?? null;
  return claimsOf(
    criteria.map((c) => ({
      issue: factOf(c),
      requirementKey: c.requirementKey,
      readings: criterionReadingsAt(factOf(c), build, { judge, judgedOn }, version),
    })),
  );
}
