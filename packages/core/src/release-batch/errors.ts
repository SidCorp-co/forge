export class NoReleaseGateError extends Error {
  constructor() {
    super('NO_RELEASE_GATE');
    this.name = 'NoReleaseGateError';
  }
}

/**
 * The project has no runner registered at all, so there is no box a release
 * could run on.
 *
 * ISS-1128 re-aimed this at the situation its name describes. It used to mean
 * "the fleet is non-empty and a declared preference excluded every box in it",
 * which is a ranking rather than a reason not to deploy.
 */
export class ReleasePoolEmptyError extends Error {
  constructor() {
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
