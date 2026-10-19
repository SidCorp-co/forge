export type { ReleaseNotes, ReleaseNotesSection } from '@forge/core/public';

/** Every reason core gives for a release not starting. Core's sentences and the web's links beside
 *  them are each keyed by it, so a reason added here is decided on both sides before it ships. */
export type ReleaseBlockerCode =
  | 'NO_RELEASE_GATE'
  | 'RELEASE_TARGET_UNDECLARED'
  | 'CLAIM_CONFLICT'
  | 'RELEASE_ROSTER_EMPTY'
  | 'RELEASE_ROSTER_OVERSIZE'
  | 'RELEASE_RECORD_MISSING'
  | 'RELEASE_WORK_UNMERGED'
  | 'RELEASE_ISSUES_UNCLOSABLE'
  | 'RELEASE_RUNNER_AMBIGUOUS'
  | 'RELEASE_PROBES_UNREADABLE'
  | 'RELEASE_POOL_EMPTY'
  | 'NO_RUNNER_ONLINE'
  | 'BATCH_IN_FLIGHT'
  | 'RELEASE_CRITERIA_UNEARNED'
  | 'RELEASE_RUNTIME_UNROUTED'
  | 'RELEASE_CARRIES_UNDECIDED'
  | 'RELEASE_CARRIED_DECISION_REFUSED'
  | 'RELEASE_CUT_DROPS_ROSTER'
  | 'RELEASE_CHECK_UNEVALUATED';
