// What a release hold says to a person (ISS-684): for each code the automatic release records,
// one plain sentence for why it is held, the act that clears it as a verb phrase, and who does it.
// The issue's standing and the Delivery page both read it, so the words agree everywhere. The code
// and the release's own reason stay in the standing's rule, the technical view.

import type { ReleaseHoldOwer } from '@forge/contracts/releases';
import { type Said, type SaidPlainKey, say } from '@forge/contracts/said';

/** Who clears a hold: a person who can write, the owner of a runner, a project admin, the issue's agent, or the release itself. */
export type ReleaseHoldActor = 'person' | 'runnerOwner' | 'admin' | 'agent' | 'release';

interface Words {
  cause: SaidPlainKey;
  act: SaidPlainKey;
  actor: ReleaseHoldActor;
}

const WORDS: Readonly<Record<string, Words>> = {
  RELEASE_CRITERIA_UNEARNED: {
    cause: 'issues.releaseHold.cause.releaseCriteriaUnearned',
    act: 'issues.releaseHold.act.releaseCriteriaUnearned',
    actor: 'person',
  },
  RELEASE_CRITERIA_HELD_BACK: {
    cause: 'issues.releaseHold.cause.releaseCriteriaHeldBack',
    act: 'issues.releaseHold.act.releaseCriteriaHeldBack',
    actor: 'person',
  },
  RELEASE_CRITERIA_UNCORROBORATED: {
    cause: 'issues.releaseHold.cause.releaseCriteriaUncorroborated',
    act: 'issues.releaseHold.act.releaseCriteriaUncorroborated',
    actor: 'person',
  },
  RELEASE_CRITERIA_UNREADABLE: {
    cause: 'issues.releaseHold.cause.releaseCriteriaUnreadable',
    act: 'issues.releaseHold.act.releaseCriteriaUnreadable',
    actor: 'person',
  },
  RELEASE_RUNTIME_UNROUTED: {
    cause: 'issues.releaseHold.cause.releaseRuntimeUnrouted',
    act: 'issues.releaseHold.act.releaseRuntimeUnrouted',
    actor: 'person',
  },
  RELEASE_TARGET_UNDECLARED: {
    cause: 'issues.releaseHold.cause.releaseTargetUndeclared',
    act: 'issues.releaseHold.act.releaseTargetUndeclared',
    actor: 'person',
  },
  RELEASE_GATE_UNREADABLE: {
    cause: 'issues.releaseHold.cause.releaseGateUnreadable',
    act: 'issues.releaseHold.act.releaseGateUnreadable',
    actor: 'person',
  },
  RELEASE_PROBES_UNREADABLE: {
    cause: 'issues.releaseHold.cause.releaseProbesUnreadable',
    act: 'issues.releaseHold.act.releaseProbesUnreadable',
    actor: 'person',
  },
  RELEASE_QUEUED_BEHIND: {
    cause: 'issues.releaseHold.cause.releaseQueuedBehind',
    act: 'issues.releaseHold.act.releaseQueuedBehind',
    actor: 'release',
  },
  NO_RELEASE_GATE: {
    cause: 'issues.releaseHold.cause.noReleaseGate',
    act: 'issues.releaseHold.act.noReleaseGate',
    actor: 'person',
  },
  RELEASE_NO_ACTOR: {
    cause: 'issues.releaseHold.cause.releaseNoActor',
    act: 'issues.releaseHold.act.releaseNoActor',
    actor: 'admin',
  },
  RELEASE_CUT_FAILED: {
    cause: 'issues.releaseHold.cause.releaseCutFailed',
    act: 'issues.releaseHold.act.releaseCutFailed',
    actor: 'person',
  },
  RELEASE_CUT_REFUSED: {
    cause: 'issues.releaseHold.cause.releaseCutRefused',
    act: 'issues.releaseHold.act.releaseCutRefused',
    actor: 'person',
  },
  RELEASE_ABORT_BLOCKED: {
    cause: 'issues.releaseHold.cause.releaseAbortBlocked',
    act: 'issues.releaseHold.act.releaseAbortBlocked',
    actor: 'person',
  },
  RELEASE_UNCLOSED_QUESTION: {
    cause: 'issues.releaseHold.cause.releaseUnclosedQuestion',
    act: 'issues.releaseHold.act.releaseUnclosedQuestion',
    actor: 'person',
  },
  RELEASE_UNCLOSED_REFUSED: {
    cause: 'issues.releaseHold.cause.releaseUnclosedRefused',
    act: 'issues.releaseHold.act.releaseUnclosedRefused',
    actor: 'person',
  },
  BATCH_IN_FLIGHT: {
    cause: 'issues.releaseHold.cause.batchInFlight',
    act: 'issues.releaseHold.act.batchInFlight',
    actor: 'release',
  },
  CLAIM_CONFLICT: {
    cause: 'issues.releaseHold.cause.claimConflict',
    act: 'issues.releaseHold.act.claimConflict',
    actor: 'release',
  },
  NO_RUNNER_ONLINE: {
    cause: 'issues.releaseHold.cause.noRunnerOnline',
    act: 'issues.releaseHold.act.noRunnerOnline',
    actor: 'runnerOwner',
  },
  RELEASE_POOL_EMPTY: {
    cause: 'issues.releaseHold.cause.releasePoolEmpty',
    act: 'issues.releaseHold.act.releasePoolEmpty',
    actor: 'runnerOwner',
  },
  RELEASE_RUNNER_PREFERENCE_UNMET: {
    cause: 'issues.releaseHold.cause.releaseRunnerPreferenceUnmet',
    act: 'issues.releaseHold.act.releaseRunnerPreferenceUnmet',
    actor: 'runnerOwner',
  },
  RELEASE_CHANGE_REQUEST_CARRIES_UNRELEASED: {
    cause: 'issues.releaseHold.cause.releaseChangeRequestCarriesUnreleased',
    act: 'issues.releaseHold.act.releaseChangeRequestCarriesUnreleased',
    actor: 'person',
  },
  RELEASE_THROUGH_CHANGE_REQUESTS: {
    cause: 'issues.releaseHold.cause.releaseThroughChangeRequests',
    act: 'issues.releaseHold.act.releaseThroughChangeRequests',
    actor: 'person',
  },
  RELEASE_RECORD_MISSING: {
    cause: 'issues.releaseHold.cause.releaseRecordMissing',
    act: 'issues.releaseHold.act.releaseRecordMissing',
    actor: 'person',
  },
  RELEASE_ROSTER_EMPTY: {
    cause: 'issues.releaseHold.cause.releaseRosterEmpty',
    act: 'issues.releaseHold.act.releaseRosterEmpty',
    actor: 'person',
  },
  RELEASE_ROSTER_OVERSIZE: {
    cause: 'issues.releaseHold.cause.releaseRosterOversize',
    act: 'issues.releaseHold.act.releaseRosterOversize',
    actor: 'person',
  },
  RELEASE_VERSION_UNDECIDED: {
    cause: 'issues.releaseHold.cause.releaseVersionUndecided',
    act: 'issues.releaseHold.act.releaseVersionUndecided',
    actor: 'person',
  },
  RELEASE_WORK_UNMERGED: {
    cause: 'issues.releaseHold.cause.releaseWorkUnmerged',
    act: 'issues.releaseHold.act.releaseWorkUnmerged',
    actor: 'person',
  },
  RELEASE_SHIPPED_IN_OWED: {
    cause: 'issues.releaseHold.cause.releaseShippedInOwed',
    act: 'issues.releaseHold.act.releaseShippedInOwed',
    actor: 'agent',
  },
  RELEASE_CLEANUP_PENDING: {
    cause: 'issues.releaseHold.cause.releaseCleanupPending',
    act: 'issues.releaseHold.act.releaseCleanupPending',
    actor: 'agent',
  },
};

/** A code this table lacks is still said plainly, by who owes it. */
const FALLBACK: Readonly<Record<ReleaseHoldOwer, Words>> = {
  human: {
    cause: 'issues.releaseHold.cause.humanFallback',
    act: 'issues.releaseHold.act.humanFallback',
    actor: 'person',
  },
  agent: {
    cause: 'issues.releaseHold.cause.agentFallback',
    act: 'issues.releaseHold.act.agentFallback',
    actor: 'release',
  },
};

export interface ReleaseHoldWords {
  cause: Said;
  act: Said;
  actor: ReleaseHoldActor;
}

export function releaseHoldWords(hold: { code: string; owes: ReleaseHoldOwer }): ReleaseHoldWords {
  const w = WORDS[hold.code] ?? FALLBACK[hold.owes];
  return { cause: say(w.cause), act: say(w.act), actor: w.actor };
}

/** Every code with its own words, for the test that holds each to a plain sentence. */
export const WORDED_RELEASE_HOLDS: readonly string[] = Object.keys(WORDS);
