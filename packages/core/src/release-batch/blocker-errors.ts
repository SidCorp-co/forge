import type {
  HeldIssueRef,
  ReleaseBlockedError,
  ReleaseBlocker,
  ReleaseBlockerReport,
} from './blocker-sentences.js';
import { ReleaseRunnerAmbiguousError } from './channel.js';
import { readClaimConflictDetails } from './claim-conflicts.js';
import {
  BatchInFlightError,
  ClaimConflictError,
  NoReleaseGateError,
  NoRunnerOnlineError,
  ReleaseMultiChannelUnsupportedError,
  ReleasePoolEmptyError,
  ReleaseProbesUndeclaredError,
  ReleaseRecordMissingError,
  ReleaseWorkUnmergedError,
} from './errors.js';
import { ReleaseTargetUndeclaredError } from './gate.js';

/**
 * The error the first blocker is thrown as, carrying the whole list.
 *
 * The class, the code and the wording are the ones that door already used, so
 * nothing's `instanceof` and no operator's vocabulary moves. What rides along
 * is every other reason standing at the same moment — which is the issue.
 */
export function releaseBlockerError(report: ReleaseBlockerReport): ReleaseBlockedError | null {
  const first = report.blockers[0];
  if (!first) return null;
  const ids = Array.isArray(first.details?.issueIds) ? (first.details.issueIds as string[]) : [];
  const err = errorFor(first, ids, report);
  const carried: ReleaseBlockedError = err;
  carried.releaseBlockers = report.blockers;
  return carried;
}

export class ReleaseCheckUnevaluatedError extends Error {
  constructor(public readonly check: string) {
    super(`RELEASE_CHECK_UNEVALUATED: ${check}`);
    this.name = 'ReleaseCheckUnevaluatedError';
  }
}

/** The probes declare a url no request could be made to. */
export class ReleaseProbesUnreadableError extends Error {
  constructor(public readonly urls: string[]) {
    super(`RELEASE_PROBES_UNREADABLE: ${urls.join(', ')}`);
    this.name = 'ReleaseProbesUnreadableError';
  }
}

/** Every issue the unattended sweep would carry is held on a criterion. */
export class ReleaseCriteriaUnearnedError extends Error {
  constructor(public readonly held: HeldIssueRef[]) {
    super(`RELEASE_CRITERIA_UNEARNED: ${held.map((h) => h.issueId).join(', ')}`);
    this.name = 'ReleaseCriteriaUnearnedError';
  }
}

/** The roster read for this project cannot be cut as one release. */
export class ReleaseRosterUnusableError extends Error {
  constructor(
    public readonly code: 'RELEASE_ROSTER_EMPTY' | 'RELEASE_ROSTER_OVERSIZE',
    public readonly waiting: number,
  ) {
    super(`${code}: ${waiting} issue(s) at the release gate`);
    this.name = 'ReleaseRosterUnusableError';
  }
}

function errorFor(
  first: ReleaseBlocker,
  ids: string[],
  report: ReleaseBlockerReport,
): ReleaseBlockedError {
  switch (first.code) {
    case 'NO_RELEASE_GATE':
      return new NoReleaseGateError();
    case 'RELEASE_TARGET_UNDECLARED':
      return new ReleaseTargetUndeclaredError(
        report.projectId,
        (first.details?.releaseModel as 'promote' | 'publish') ?? 'publish',
      );
    case 'CLAIM_CONFLICT':
      return new ClaimConflictError(ids, readClaimConflictDetails(first.details));
    case 'RELEASE_ROSTER_EMPTY':
    case 'RELEASE_ROSTER_OVERSIZE':
      return new ReleaseRosterUnusableError(first.code, Number(first.details?.waiting ?? 0));
    case 'RELEASE_RECORD_MISSING':
      return new ReleaseRecordMissingError(ids);
    case 'RELEASE_WORK_UNMERGED':
      return new ReleaseWorkUnmergedError(ids);
    case 'RELEASE_RUNNER_AMBIGUOUS':
      return new ReleaseRunnerAmbiguousError(
        report.projectId,
        (first.details?.labels as string[]) ?? [],
      );
    case 'RELEASE_PROBES_UNDECLARED':
      return new ReleaseProbesUndeclaredError();
    case 'RELEASE_PROBES_UNREADABLE':
      return new ReleaseProbesUnreadableError((first.details?.urls as string[]) ?? []);
    case 'RELEASE_POOL_EMPTY':
      return new ReleasePoolEmptyError();
    case 'NO_RUNNER_ONLINE':
      return new NoRunnerOnlineError();
    case 'RELEASE_MULTI_CHANNEL_UNSUPPORTED':
      return new ReleaseMultiChannelUnsupportedError(Number(first.details?.count ?? 0));
    case 'BATCH_IN_FLIGHT':
      return new BatchInFlightError(null);
    case 'RELEASE_CRITERIA_UNEARNED':
      // Roster-scoped, so no door that throws can reach it: both call with a
      // named list. The arm is here because the switch is exhaustive, and it
      // refuses by name rather than falling through.
      return new ReleaseCriteriaUnearnedError((first.details?.held as HeldIssueRef[]) ?? []);
    case 'RELEASE_CHECK_UNEVALUATED':
      return new ReleaseCheckUnevaluatedError(String(first.details?.check ?? 'unknown'));
  }
}
