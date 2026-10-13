import { describeOperation, fail, json } from '../api-reference/describe.js';
import {
  abortedSchema,
  activeSchema,
  attemptRowSchema,
  batchContextSchema,
  createdSchema,
  finishAcceptedSchema,
  lookSchema,
  methodSchema,
  readinessSchema,
  recordedSchema,
  recordViewSchema,
  rosterSchema,
  servingSchema,
  stateSchema,
} from './routes-reference-shapes.js';

const noProject = fail('NOT_FOUND', 'the project does not exist, or the caller cannot see it');
const noBatch = fail(
  'NOT_FOUND',
  'no release batch of this project has this id, or the project cannot be seen',
);
const needsMember = fail('FORBIDDEN', 'the caller holds less than the project member role');
const needsAdmin = fail('FORBIDDEN', 'the caller holds less than the project admin role');

/** Every reason a release is refused for a declaration, a roster or a fleet that must change. */
const blockerWhen = {
  NO_RELEASE_GATE: 'the project declares no release gate',
  RELEASE_TARGET_UNDECLARED: 'the project declares no release chain to release into',
  CLAIM_CONFLICT: 'a roster issue is already claimed by another batch, or is not at the gate',
  RELEASE_ROSTER_EMPTY: 'no issue waits at the release gate',
  RELEASE_ROSTER_OVERSIZE: 'the roster is larger than one release may carry',
  RELEASE_RECORD_MISSING: 'a roster issue has no release note',
  RELEASE_WORK_UNMERGED: 'a roster issue is not marked merged',
  RELEASE_ISSUES_UNCLOSABLE: 'a roster issue would be refused its close',
  RELEASE_RUNNER_AMBIGUOUS: 'the live bindings name more than one release runner',
  RELEASE_PROBES_UNREADABLE: 'a live binding declares a verify probe nothing can request',
  BATCH_IN_FLIGHT: 'another release of this project is still running',
  RELEASE_CRITERIA_UNEARNED: 'a roster issue holds acceptance criteria no verdict has earned',
  RELEASE_RUNTIME_UNROUTED: 'the runtime the release needs is routed to no box',
  RELEASE_CARRIES_UNDECIDED: 'the range carries issues off the roster that have no decision',
  RELEASE_CARRIED_DECISION_REFUSED: 'a decision on a carried issue was refused',
  RELEASE_CUT_DROPS_ROSTER: 'the decided cut leaves a roster issue above it',
};

const releaseFleet = fail({
  RELEASE_POOL_EMPTY: 'the project has no runner registered at all',
  NO_RUNNER_ONLINE: 'no runner able to release is online',
  RELEASE_CHECK_UNEVALUATED: 'a release check could not be run',
});

export const createBatch = describeOperation({
  summary: 'Open a release batch over the issues waiting at the gate and queue its job',
  description:
    'Claims the named issues, cuts the next version and queues one release job. Every reason a release would be refused is enumerated, the first answers and the rest ride in `details.alsoBlocking`.',
  responses: {
    201: json(createdSchema, 'The batch, its job and the version it cut'),
    400: fail(
      'RELEASE_ISSUES_UNNAMED',
      'the call named no issue while issues wait at the gate; the message lists the roster to send',
    ),
    403: needsAdmin,
    404: noProject,
    409: fail({
      ...blockerWhen,
      RELEASE_RECUT_REFUSED: '`recutOf` does not name the highest release, or that release shipped',
      RELEASE_VERSION_CONFLICT: 'another release took the version between the cut and the write',
      RELEASE_VERSION_EXHAUSTED: 'the version space of this release line is used up',
    }),
    503: releaseFleet,
  },
});

export const readActiveBatch = describeOperation({
  summary: 'The release batch running now, or null when none is',
  responses: {
    200: json(activeSchema, 'The running batch, or null'),
    403: needsMember,
    404: noProject,
  },
});

export const readRoster = describeOperation({
  summary:
    'Everything waiting for a release, oldest merge first, with what each close would refuse',
  responses: {
    200: json(rosterSchema),
    403: needsMember,
    404: noProject,
    409: fail({
      RELEASE_TARGET_UNDECLARED: 'the project declares no release chain to release into',
      RELEASE_RUNNER_AMBIGUOUS: 'the live bindings name more than one release runner',
    }),
  },
});

export const readReadiness = describeOperation({
  summary:
    'What a release of this project would meet now: its declaration, its gaps and what blocks it',
  responses: { 200: json(readinessSchema), 403: needsMember, 404: noProject },
});

export const readDeployment = describeOperation({
  summary: 'What the live deployment is serving, read from the probes the project declares',
  description:
    'Reads the live probes at request time; `verified` is false where no live binding declares one.',
  responses: {
    200: json(servingSchema),
    403: needsMember,
    404: noProject,
    409: fail({
      PROBES_UNREADABLE: 'a live binding declares a verify block that cannot be read',
      PROBE_URL_INVALID: 'a declared probe url is not a url',
    }),
  },
});

export const readBatch = describeOperation({
  summary: 'One release batch as it was opened: its version, branches, runner and issues',
  responses: {
    200: json(batchContextSchema, 'The batch, or null for a run that is not a batch'),
    403: needsMember,
    404: noBatch,
  },
});

export const finishBatch = describeOperation({
  summary: 'Finish a release batch: verify what serves and close the roster',
  description:
    'Answers 200 once the close is done and 202 while it is still running, so poll the batch state for `finish`. A repeat call answers the attempt already standing.',
  responses: {
    200: json(finishAcceptedSchema, 'The finish attempt, finished'),
    202: json(finishAcceptedSchema, 'The finish attempt, still running'),
    403: needsMember,
    404: noBatch,
    409: fail({
      RELEASE_NOT_VERIFIED: 'the readings recorded do not show the named commit serving',
      RELEASE_PROBES_UNREADABLE: 'a live binding declares a verify probe nothing can request',
      RELEASE_VERSION_MISSING: 'the batch has no version to close',
      RELEASE_BATCH_ABORTED: 'the batch was aborted, so it closes no issue',
      RELEASE_FINISH_IN_FLIGHT: 'a finish for another commit is already running on this batch',
      RELEASE_FINISHED_FOR_OTHER_COMMIT: 'the batch already finished for another commit',
    }),
  },
});

export const lookAtLive = describeOperation({
  summary: 'Read the live bindings now, keep the reading and say whether the finish would close',
  responses: {
    201: json(lookSchema, 'The reading and what the readings so far would close'),
    403: needsMember,
    404: noBatch,
    409: fail({
      RELEASE_NOT_VERIFIED: 'the named commit is not a whole commit sha',
      RELEASE_PROBES_UNREADABLE: 'a live binding declares a verify probe nothing can request',
      RELEASE_VERSION_MISSING: 'the batch has no version to close',
      RELEASE_BATCH_ABORTED: 'the batch was aborted',
      RELEASE_FINISH_IN_FLIGHT: 'a finish for another commit is already running on this batch',
      RELEASE_FINISHED_FOR_OTHER_COMMIT: 'the batch already finished for another commit',
      RELEASE_NOTHING_TO_READ: 'no live binding declares a probe, so there is nothing to read',
      RELEASE_RUN_CLOSED: 'the batch run is over and takes no further reading',
    }),
  },
});

export const abortBatch = describeOperation({
  summary: 'Abort a release batch, cancel its jobs and hand the roster back',
  description:
    'Closes no issue. `promotedRoster` says what becomes of a roster whose run already promoted: `hold` (the default) leaves it at releasing, `return-to-gate` puts it back for a release record.',
  responses: {
    200: json(abortedSchema, 'What the abort did to the run and the roster'),
    403: needsMember,
    404: noBatch,
  },
});

export const readBatchState = describeOperation({
  summary: 'The whole of a release batch now: its roster, attempts, readings, bounds and finish',
  responses: { 200: json(stateSchema), 403: needsMember, 404: noBatch },
});

export const announceBatchMethod = describeOperation({
  summary: 'Record which skill the release run says it loaded, or that it could not load one',
  responses: { 200: json(methodSchema, 'The method as recorded'), 403: needsMember, 404: noBatch },
});

export const openBatchAttempt = describeOperation({
  summary: 'Record the intent of a release act before performing it',
  description:
    'The same idempotency key answers the same attempt. `health`, `identity`, `verdict`, `verdictReason` and `readings` are core’s to write and refused if sent.',
  responses: {
    201: json(attemptRowSchema, 'The attempt'),
    400: fail(
      'RELEASE_VERDICT_NOT_YOURS',
      'the body carries a key only core writes: health, identity, verdict, verdictReason or readings',
    ),
    403: needsMember,
    404: noBatch,
    409: fail(
      'RELEASE_RUN_HOLDING',
      'the run is past its total, stall or regression bound and records no further attempts',
    ),
  },
});

export const accountForAttempt = describeOperation({
  summary: 'Report back what a release act did, and take core’s verdict on it',
  responses: {
    200: json(attemptRowSchema.nullable(), 'The attempt, settled with core’s verdict'),
    400: fail(
      'RELEASE_VERDICT_NOT_YOURS',
      'the body carries a key only core writes: health, identity, verdict, verdictReason or readings',
    ),
    403: needsMember,
    404: fail('NOT_FOUND', 'no such batch, project or attempt: record the intent first'),
  },
});

export const recordRelease = describeOperation({
  summary: 'Record a release that was performed by hand and close its issues against what serves',
  responses: {
    201: json(recordedSchema, 'The record and what it closed'),
    403: needsAdmin,
    404: noProject,
    409: fail({
      ...blockerWhen,
      RELEASE_NOT_VERIFIED: 'the probes do not show the named commit serving',
    }),
    503: releaseFleet,
  },
});

export const readRecordedRelease = describeOperation({
  summary: 'Read back a release record: its commit, account and the issues it named',
  responses: {
    200: json(recordViewSchema),
    403: needsMember,
    404: fail('NOT_FOUND', 'no such project, or no release record under this id on it'),
  },
});
