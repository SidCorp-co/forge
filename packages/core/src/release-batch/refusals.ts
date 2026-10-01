/**
 * Every refusal `releaseBatchRoutes` makes, in one place.
 *
 * The messages carry the remedy, because a refusal an operator cannot act on is a 500 with
 * better manners — `middleware/error.ts` `extractCause` copies only `code`, `details` and
 * `wwwAuthenticate`, so anything the caller needs has to be in one of those three.
 */

import { HTTPException } from 'hono/http-exception';
import { ABORTED_CODE, abortedSentence } from './abort-stamp.js';
import {
  alsoBlocking,
  blockerHttpStatus,
  blockersOf,
  RELEASE_ROSTER_LIMIT,
  type ReleaseBlockerCode,
  releaseBlockerSentence,
} from './blocker-sentences.js';
import {
  ClaimConflictError,
  NoReleaseGateError,
  ReleaseBatchAbortedError,
  ReleaseFinishedForOtherCommitError,
  ReleaseFinishInFlightError,
  ReleaseNotVerifiedError,
  ReleaseProbesUnreadableError,
  ReleaseVersionMissingError,
} from './errors.js';
import { ReleaseTargetUndeclaredError } from './gate.js';
import type { ReleaseRunHoldingError } from './state.js';

export const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const conflict = (code: string, message: string, details?: unknown) =>
  new HTTPException(409, {
    message,
    cause: details === undefined ? { code } : { code, details },
  });

export const serviceUnavailable = (code: string, message: string) =>
  new HTTPException(503, { message, cause: { code } });

/**
 * One refusal, carrying every reason that stood beside it.
 *
 * ISS-1127: releasing ISS-1103 by hand was refused twice by this same endpoint
 * minutes apart — a missing release note, and then a merge nobody had marked —
 * each individually correct and neither mentioning the other. The thrown code
 * and its wording are unchanged; `alsoBlocking` is what stops the second
 * refusal being a surprise.
 */
export function releaseBlockerHttp(
  err: unknown,
  code: ReleaseBlockerCode,
  details?: Record<string, unknown>,
): HTTPException {
  const standing = alsoBlocking(err, code);
  const body: Record<string, unknown> = { ...(details ?? {}) };
  if (standing.length > 0) body.alsoBlocking = standing;
  return new HTTPException(blockerHttpStatus(code), {
    message: releaseBlockerSentence(code, details),
    cause: Object.keys(body).length > 0 ? { code, details: body } : { code },
  });
}

/**
 * A report's first entry as readiness serialises it, the rest as `alsoBlocking`.
 * Never rebuilt from the error's class, whose fields are fewer than the entry's
 * (ISS-1127 criteria 1, 9). Null where no report rode on the error.
 */
export function reportedRefusal(err: unknown): HTTPException | null {
  const [head, ...rest] = blockersOf(err);
  if (!head) return null;
  const details: Record<string, unknown> = { ...(head.details ?? {}) };
  if (rest.length > 0) details.alsoBlocking = rest;
  return new HTTPException(head.httpStatus, {
    message: head.message,
    cause: Object.keys(details).length > 0 ? { code: head.code, details } : { code: head.code },
  });
}

export function declarationRefusal(err: unknown): HTTPException | null {
  // Each of these composes through `releaseBlockerSentence`, from the same
  // details `blockers.ts` passes it for readiness — one function, one text,
  // whichever door reads it (ISS-1127 criterion 9).
  if (err instanceof ReleaseTargetUndeclaredError) {
    return carrying(
      err,
      'RELEASE_TARGET_UNDECLARED',
      releaseBlockerSentence('RELEASE_TARGET_UNDECLARED', { reason: err.reason }),
    );
  }
  return null;
}

/** One refusal, its own sentence, and every reason standing beside it. */
function carrying(err: unknown, code: ReleaseBlockerCode, message: string): HTTPException {
  const standing = alsoBlocking(err, code);
  return new HTTPException(blockerHttpStatus(code), {
    message,
    cause: standing.length > 0 ? { code, details: { alsoBlocking: standing } } : { code },
  });
}

export function unreadableProbes(err: ReleaseProbesUnreadableError): HTTPException {
  return releaseBlockerHttp(err, 'RELEASE_PROBES_UNREADABLE', { bindings: err.bindings });
}

export function issuesUnnamed(projectId: string): HTTPException {
  return new HTTPException(400, {
    message:
      `This call names no issue to release, and issues are waiting at the release gate. Send the ids GET /api/projects/${projectId}/release-batches/roster lists, oldest merge first, at most ` +
      `${RELEASE_ROSTER_LIMIT} in one release.`,
    cause: { code: 'RELEASE_ISSUES_UNNAMED' },
  });
}

// so the refusal has to say where the verdict actually comes from, or the next caller sends it
// again under a different spelling.
export const MACHINE_ONLY_KEYS = [
  'health',
  'identity',
  'verdict',
  'verdictReason',
  'readings',
] as const;

export function refuseMachineKeys(body: Record<string, unknown>): void {
  const sent = MACHINE_ONLY_KEYS.filter((k) => k in body);
  if (sent.length === 0) return;
  throw new HTTPException(400, {
    message: `\`${sent.join('`, `')}\` ${sent.length === 1 ? 'is' : 'are'} core's reading and not yours to send. Core takes them from this project's declared probes at the moment you record your account, and stores them beside it. Send \`account\`, and \`providerRef\` for the provider's own handle on what you did.`,
    cause: { code: 'RELEASE_VERDICT_NOT_YOURS', details: { keys: sent } },
  });
}
export function holding(err: ReleaseRunHoldingError): HTTPException {
  return conflict(
    'RELEASE_RUN_HOLDING',
    `This release run is past its ${err.crossed.join(' and ')} bound, so it records no further attempts. Read GET .../state, then either finish it or abort it with what you found.`,
  );
}

/**
 * Each refusal under the name the batch route already gives it: a caller that learns
 * `RELEASE_PROBES_UNREADABLE` from a batch must not meet a second name for the same fact here.
 */
export function recordRefusal(err: unknown): HTTPException {
  const reported = reportedRefusal(err);
  if (reported) return reported;
  const declined = declarationRefusal(err);
  if (declined) return declined;

  if (err instanceof NoReleaseGateError) return releaseBlockerHttp(err, 'NO_RELEASE_GATE');
  if (err instanceof ReleaseProbesUnreadableError) return unreadableProbes(err);
  if (err instanceof ReleaseNotVerifiedError) {
    return new HTTPException(409, {
      message: err.reason,
      cause: { code: 'RELEASE_NOT_VERIFIED', reason: err.reason, live: err.live },
    });
  }
  if (err instanceof ClaimConflictError) {
    return releaseBlockerHttp(err, 'CLAIM_CONFLICT', err.details ?? { issueIds: err.issueIds });
  }
  throw err;
}

/**
 * Every refusal a finish can meet, at the door or inside the job that does the work, under one
 * set of names. The job writes the code and the sentence onto the batch; the door answers them.
 */
export function finishRefusal(err: unknown): HTTPException | null {
  if (err instanceof ReleaseNotVerifiedError) {
    return new HTTPException(409, {
      message: err.reason,
      cause: { code: 'RELEASE_NOT_VERIFIED', details: { live: err.live } },
    });
  }
  if (err instanceof ReleaseProbesUnreadableError) return unreadableProbes(err);
  if (err instanceof ReleaseVersionMissingError) {
    return conflict('RELEASE_VERSION_MISSING', err.message);
  }
  if (err instanceof ReleaseBatchAbortedError) {
    return conflict(
      ABORTED_CODE,
      abortedSentence(err),
      err.closed === null ? { account: err.account } : { account: err.account, closed: err.closed },
    );
  }
  if (err instanceof ReleaseFinishInFlightError) {
    const { projectId, runId } = err.where;
    return conflict(
      'RELEASE_FINISH_IN_FLIGHT',
      `A finish for ${err.inFlightCommit ?? 'no named commit'} is already running on this batch, and this call names ${err.askedCommit ?? 'no commit'}. Read its outcome with GET /api/projects/${projectId}/release-batches/${runId}/state (\`finish\`); a new finish is taken once that one has failed.`,
      { requestId: err.requestId, inFlightCommit: err.inFlightCommit },
    );
  }
  if (err instanceof ReleaseFinishedForOtherCommitError) {
    const { projectId, runId } = err.where;
    return conflict(
      'RELEASE_FINISHED_FOR_OTHER_COMMIT',
      `${finishedForSentence(err)} Read what it recorded with GET /api/projects/${projectId}/release-batches/${runId}/state (\`finish\`).`,
      { requestId: err.requestId, finishedCommit: err.finishedCommit },
    );
  }
  return null;
}

/** Which commit a finished batch verified, against the one a later finish names; both doors say it. */
export function finishedForSentence(err: ReleaseFinishedForOtherCommitError): string {
  const verified =
    err.finishedCommit === null
      ? 'finished with no named commit, on a live build that had changed from what was serving when it opened'
      : `finished for ${err.finishedCommit}`;
  return `This batch already ${verified}, and this call names ${err.askedCommit}, which that finish never verified. A finished batch is not verified again, so its issues' closes say nothing about ${err.askedCommit}; a release of ${err.askedCommit} is a batch of its own.`;
}
