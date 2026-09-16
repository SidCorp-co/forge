/**
 * Every refusal `createReleaseBatch` and `finishReleaseBatch` make, as types.
 *
 * Split out of `service.ts` when the multi-channel refusal pushed that file past its 500-line
 * budget (ISS-1046). They belong together because they are one vocabulary: each is a way a
 * project's own declaration says a release cannot be performed, and `release-batch/refusals.ts`
 * maps each to the sentence an operator reads. A refusal with no class is a 500.
 */

export class NoReleaseGateError extends Error {
  constructor() {
    super('NO_RELEASE_GATE');
    this.name = 'NoReleaseGateError';
  }
}

/**
 * The project named a release pool and no runner is in it. Distinct from
 * `NoRunnerOnlineError` on purpose: "nobody is online" and "the box that holds
 * the deploy credential lost its label" need different remedies.
 */
export class ReleasePoolEmptyError extends Error {
  constructor(public readonly label: string) {
    super('RELEASE_POOL_EMPTY');
    this.name = 'ReleasePoolEmptyError';
  }
}

/**
 * The project declares a release model but no live deploy binding names a release runner. Rule
 * 3 of ISS-897: a gate without a designated box is a refusal, never a fallback.
 */
export class ReleaseRunnerUndeclaredError extends Error {
  constructor() {
    super('RELEASE_RUNNER_UNDECLARED');
    this.name = 'ReleaseRunnerUndeclaredError';
  }
}

/**
 * The project has more than one live deploy channel, and a run can prove only one.
 *
 * ISS-1046 widened what core RETURNS from one live binding to the whole live SET, which is the
 * right answer to "where does this project release to". It did NOT widen the attempt ledger:
 * `commitBefore` is one string on the run, `readLiveState` reads one channel's probes, and
 * `finishReleaseBatch` closes the whole roster on that single reading. So a two-endpoint release
 * would be verified at one endpoint and closed for both — the quietest possible way to claim a
 * ship nobody checked.
 *
 * It refuses instead. Measured over the fleet at the 0253 cutover: of the 12 projects carrying a
 * live deploy binding, zero carry two, so this refuses nothing anyone does today and stands
 * between the first operator who adds a second one and a silently half-verified release. The way
 * out is per-binding verification, which is its own piece of work:
 * `docs/proposals/release-verifies-one-endpoint.md`.
 */
export class ReleaseMultiChannelUnsupportedError extends Error {
  readonly code = 'RELEASE_MULTI_CHANNEL_UNSUPPORTED';
  constructor(readonly count: number) {
    super(
      `RELEASE_MULTI_CHANNEL_UNSUPPORTED: this project declares ${count} live deploy bindings, and a release run records ONE reading — one \`commitBefore\`, one set of probes, one verdict — which would be taken at one of them and used to close the whole roster. Core will not claim a release it verified at one endpoint of two. Leave exactly one binding carrying the \`live\` stage active, or release them as separate projects.`,
    );
    this.name = 'ReleaseMultiChannelUnsupportedError';
  }
}

/**
 * The project declares a release gate and no verification probes, so nothing
 * but the agent's own word could say the release happened.
 */
export class ReleaseProbesUndeclaredError extends Error {
  constructor() {
    super('RELEASE_PROBES_UNDECLARED');
    this.name = 'ReleaseProbesUndeclaredError';
  }
}

export class NoRunnerOnlineError extends Error {
  constructor() {
    super('NO_RUNNER_ONLINE');
    this.name = 'NoRunnerOnlineError';
  }
}

/**
 * The probes did not agree that the release is live. `finish` refuses, so the
 * agent's only remaining move is `abort` — which is the point.
 */
export class ReleaseNotVerifiedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly live: string | null,
  ) {
    super('RELEASE_NOT_VERIFIED');
    this.name = 'ReleaseNotVerifiedError';
  }
}

/**
 * `finish` was called on a run somebody aborted.
 */
export class ReleaseBatchAbortedError extends Error {
  constructor() {
    super('RELEASE_BATCH_ABORTED');
    this.name = 'ReleaseBatchAbortedError';
  }
}

export class ClaimConflictError extends Error {
  constructor(public readonly issueIds: string[]) {
    super('CLAIM_CONFLICT');
    this.name = 'ClaimConflictError';
  }
}

/**
 * One or more issues in the batch have no release note, so the batch would
 * close them claiming a ship nobody wrote anything about.
 */
export class ReleaseRecordMissingError extends Error {
  constructor(public readonly issueIds: string[]) {
    super(`RELEASE_RECORD_MISSING: ${issueIds.length} issue(s) have no release note`);
    this.name = 'ReleaseRecordMissingError';
  }
}

export class BatchInFlightError extends Error {
  constructor(public readonly existingJobId: string | null) {
    super('BATCH_IN_FLIGHT');
    this.name = 'BatchInFlightError';
  }
}
