import type {
  HeldIssueRef,
  ReleaseBlockedError,
  ReleaseBlocker,
  ReleaseBlockerReport,
} from './blocker-sentences.js';
import { readClaimConflictDetails } from './claim-conflicts.js';
import {
  BatchInFlightError,
  ClaimConflictError,
  ContractProviderNotLiveError,
  NoReleaseGateError,
  NoRunnerOnlineError,
  ReleasePoolEmptyError,
  ReleaseProbesUnreadableError,
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

/** Every issue the unattended sweep would carry is held on a criterion. */
export class ReleaseCriteriaUnearnedError extends Error {
  constructor(public readonly held: HeldIssueRef[]) {
    super(`RELEASE_CRITERIA_UNEARNED: ${held.map((h) => h.issueId).join(', ')}`);
    this.name = 'ReleaseCriteriaUnearnedError';
  }
}

/** Nothing can read what this project serves, so no waiting issue's criteria can be earned. */
export class ReleaseRuntimeUnroutedError extends Error {
  constructor(public readonly missing: string) {
    super(`RELEASE_RUNTIME_UNROUTED: ${missing}`);
    this.name = 'ReleaseRuntimeUnroutedError';
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
        typeof first.details?.reason === 'string' ? first.details.reason : first.message,
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
    case 'CONTRACT_PROVIDER_NOT_LIVE':
      return new ContractProviderNotLiveError(ids);
    case 'RELEASE_PROBES_UNREADABLE':
      return new ReleaseProbesUnreadableError(
        (first.details?.bindings as string[] | undefined) ?? [],
      );
    case 'RELEASE_POOL_EMPTY':
      return new ReleasePoolEmptyError();
    case 'NO_RUNNER_ONLINE':
      return new NoRunnerOnlineError();
    case 'BATCH_IN_FLIGHT':
      return new BatchInFlightError(null);
    case 'RELEASE_CRITERIA_UNEARNED':
      // Roster-scoped, so no door that throws can reach it: both call with a
      // named list. The arm is here because the switch is exhaustive, and it
      // refuses by name rather than falling through.
      return new ReleaseCriteriaUnearnedError((first.details?.held as HeldIssueRef[]) ?? []);
    case 'RELEASE_RUNTIME_UNROUTED':
      // Roster-scoped like the arm above, and refused by name for the same reason.
      return new ReleaseRuntimeUnroutedError(String(first.details?.missing ?? 'unknown'));
    case 'RELEASE_CHECK_UNEVALUATED':
      return new ReleaseCheckUnevaluatedError(String(first.details?.check ?? 'unknown'));
  }
}
