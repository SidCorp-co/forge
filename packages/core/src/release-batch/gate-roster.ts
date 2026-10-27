// The release gate as a person reads it: the roster, and every reason Release now would be refused
// for, read by the enumerator the create door throws from (ISS-1127, ISS-1421 r37).

import type { ReleaseBlocker, ReleaseBlockerCode } from './blocker-sentences.js';
import { collectReleaseBlockers } from './blockers.js';
import { loadReleaseRoster, type ReleaseRoster, type ReleaseRosterEntry } from './queries.js';
import { recordMissingForRow, releaseBlockerReaderSentence } from './reader-sentences.js';

/** A reason Release now refuses one row for that its close would not: today, a missing note. */
export interface RowReleaseRefusal {
  code: 'RELEASE_RECORD_MISSING';
  said: string;
  /** The same, on the issue's own page. */
  saidHere: string;
}

/** A reason Release now is refused whatever is picked: the fleet, the declaration, a release running. */
export interface GateRefusal {
  code: ReleaseBlockerCode;
  said: string;
}

export type ReleaseGateEntry = ReleaseRosterEntry & { releaseRefusals: RowReleaseRefusal[] };

export interface ReleaseGateRoster extends Omit<ReleaseRoster, 'issues'> {
  issues: ReleaseGateEntry[];
  /** Empty where a press over the ready rows is not refused for a reason outside them. */
  blockingAll: GateRefusal[];
}

/** Shown elsewhere: the close's refusals are each row's `closeRefusals`; claim and size answer a pick. */
const SHOWN_ELSEWHERE = new Set<ReleaseBlockerCode>([
  'RELEASE_WORK_UNMERGED',
  'RELEASE_ISSUES_UNCLOSABLE',
  'CLAIM_CONFLICT',
  'RELEASE_ROSTER_OVERSIZE',
]);

function idsOf(blocker: ReleaseBlocker): string[] {
  const ids = blocker.details?.issueIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** The roster, each row with what Release now would refuse it for, and what refuses every row. */
export async function loadReleaseGateRoster(projectId: string): Promise<ReleaseGateRoster> {
  const roster = await loadReleaseRoster(projectId);
  const unclaimed = roster.issues.filter((i) => i.claimedByRunId === null).map((i) => i.id);
  const blockers =
    roster.gateStatus && unclaimed.length > 0
      ? (await collectReleaseBlockers(projectId, { door: 'batch', issueIds: unclaimed })).blockers
      : [];
  const unnoted = new Set(
    blockers.filter((b) => b.code === 'RELEASE_RECORD_MISSING').flatMap((b) => idsOf(b)),
  );
  const blockingAll = blockers
    .filter((b) => b.code !== 'RELEASE_RECORD_MISSING' && !SHOWN_ELSEWHERE.has(b.code))
    .map((b) => ({ code: b.code, said: releaseBlockerReaderSentence(b.code, b.details) }));
  return {
    ...roster,
    issues: roster.issues.map((issue) => ({
      ...issue,
      releaseRefusals: unnoted.has(issue.id)
        ? [
            {
              code: 'RELEASE_RECORD_MISSING' as const,
              said: recordMissingForRow(false),
              saidHere: recordMissingForRow(true),
            },
          ]
        : [],
    })),
    blockingAll,
  };
}
