export class NoReleaseGateError extends Error {
  constructor() {
    super('NO_RELEASE_GATE');
    this.name = 'NoReleaseGateError';
  }
}

/**
 * The call named no issue while issues wait at the gate: the caller's list,
 * not the project's state, so no blocker names it and readiness never lists it.
 * An empty gate is `RELEASE_ROSTER_EMPTY` instead, which the enumerator reports.
 */
export class ReleaseIssuesUnnamedError extends Error {
  constructor() {
    super('RELEASE_ISSUES_UNNAMED');
    this.name = 'ReleaseIssuesUnnamedError';
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

/**
 * A release row reached `finish` carrying no version, so it has no identity and closing its roster
 * would claim a ship nothing can name. ISS-1120: `createReleaseBatch` cuts the number inside the
 * transaction that inserts the row, so a versionless release row is a row something else made.
 */
export class ReleaseVersionMissingError extends Error {
  constructor(public readonly runId: string) {
    super(
      `RELEASE_VERSION_MISSING: release run ${runId} carries no version on its row, so it has no ` +
        'identity and nothing afterwards could name which release carried these issues. A release ' +
        'is versioned at the instant it is created; a row without one was not opened by ' +
        '`createReleaseBatch`. Abort this run and cut a new release.',
    );
    this.name = 'ReleaseVersionMissingError';
  }
}

/**
 * The cut could not write the number it computed. The advisory lock serializes allocation per
 * project, so reaching this means something outside `cutReleaseVersion` wrote the column — which is
 * refused rather than retried, because a second writer is the condition the identity rule exists
 * for.
 */
export class ReleaseVersionConflictError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly version: string,
  ) {
    super(
      `RELEASE_VERSION_CONFLICT: ${version} could not be cut for project ${projectId} — the row ` +
        'already carried a version, or another release on this project already wears that number. ' +
        'Allocation is serialized per project, so this means a writer other than ' +
        '`cutReleaseVersion` set `pipeline_runs.release_version`. Nothing was cut.',
    );
    this.name = 'ReleaseVersionConflictError';
  }
}

/**
 * A re-cut was asked for and the version it names is not one that may be re-cut. The owner reserved
 * the patch digit for a re-cut after a FAILED release (ISS-1120), so each of the four ways a caller
 * can miss that is named rather than normalized into a fresh minor.
 */
export class ReleaseRecutRefusedError extends Error {
  constructor(
    public readonly recutOf: string,
    public readonly reason: string,
  ) {
    super(`RELEASE_RECUT_REFUSED: ${recutOf} cannot be re-cut — ${reason}`);
    this.name = 'ReleaseRecutRefusedError';
  }
}

/**
 * The next version would take a component past nine digits, which the column's CHECK refuses and
 * the store's `int4` ordering could not compare. A project reaching this has cut a billion
 * releases; it is refused by its own name anyway, because the alternative is a constraint naming
 * itself and leaving the caller to work out which rule they hit.
 */
export class ReleaseVersionExhaustedError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly wanted: string,
  ) {
    super(
      `RELEASE_VERSION_EXHAUSTED: the next version for project ${projectId} would be ${wanted}, ` +
        'and a release version holds at most nine digits per component. Nothing was cut. Raise the ' +
        'major digit by hand on the next release row to start a fresh sequence.',
    );
    this.name = 'ReleaseVersionExhaustedError';
  }
}

/**
 * One or more issues named by a release record have no `merged_at`, so Forge
 * never watched their work land.
 *
 * The probes prove what production is serving. They prove nothing about an
 * issue whose branch nobody merged, and closing it would claim a ship for work
 * that is not on the base branch at all.
 */
export class ReleaseWorkUnmergedError extends Error {
  constructor(public readonly issueIds: string[]) {
    super(`RELEASE_WORK_UNMERGED: ${issueIds.length} issue(s) have no merge Forge watched land`);
    this.name = 'ReleaseWorkUnmergedError';
  }
}
