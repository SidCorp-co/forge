/**
 * Every refusal `releaseBatchRoutes` makes, in one place.
 *
 * Split out of `routes.ts` when the two declaration refusals pushed that file past its
 * 500-line budget (ISS-1046). The seam is the one the router already had: these are the
 * sentences an operator reads, and none of them is about routing.
 *
 * The messages carry the remedy, because a refusal an operator cannot act on is a 500 with
 * better manners — `middleware/error.ts` `extractCause` copies only `code`, `details` and
 * `wwwAuthenticate`, so anything the caller needs has to be in one of those three.
 */

import { HTTPException } from 'hono/http-exception';
import {
  alsoBlocking,
  blockerHttpStatus,
  type ReleaseBlockerCode,
  releaseBlockerSentence,
} from './blocker-sentences.js';
import {
  ReleaseCheckUnevaluatedError,
  ReleaseProbesUnreadableError,
  ReleaseRosterUnusableError,
} from './blockers.js';
import { ReleaseRunnerAmbiguousError } from './channel.js';
import {
  ClaimConflictError,
  NoReleaseGateError,
  ReleaseNotVerifiedError,
  ReleaseProbesUndeclaredError,
  ReleaseRecordMissingError,
  ReleaseWorkUnmergedError,
} from './errors.js';
import { ReleaseTargetUndeclaredError } from './gate.js';
import { MethodMismatchError, MethodNotAnnouncedError } from './method.js';
import { RELEASE_BATCH_SKILL } from './plan.js';
import { ReleaseMultiChannelUnsupportedError } from './service.js';
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

export function declarationRefusal(err: unknown): HTTPException | null {
  // Each of these composes through `releaseBlockerSentence`, from the same
  // details `blockers.ts` passes it for readiness — one function, one text,
  // whichever door reads it (ISS-1127 criterion 9).
  if (err instanceof ReleaseTargetUndeclaredError) {
    return carrying(
      err,
      'RELEASE_TARGET_UNDECLARED',
      releaseBlockerSentence('RELEASE_TARGET_UNDECLARED', { releaseModel: err.releaseModel }),
    );
  }
  if (err instanceof ReleaseRunnerAmbiguousError) {
    return carrying(
      err,
      'RELEASE_RUNNER_AMBIGUOUS',
      releaseBlockerSentence('RELEASE_RUNNER_AMBIGUOUS', { labels: err.labels }),
    );
  }
  if (err instanceof ReleaseMultiChannelUnsupportedError) {
    return carrying(
      err,
      'RELEASE_MULTI_CHANNEL_UNSUPPORTED',
      releaseBlockerSentence('RELEASE_MULTI_CHANNEL_UNSUPPORTED', { count: err.count }),
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

export function undeclaredProbes(err?: unknown): HTTPException {
  return carrying(
    err,
    'RELEASE_PROBES_UNDECLARED',
    releaseBlockerSentence('RELEASE_PROBES_UNDECLARED'),
  );
}

export function undeclaredBranches(err?: unknown): HTTPException {
  return carrying(
    err,
    'RELEASE_BRANCHES_UNDECLARED',
    releaseBlockerSentence('RELEASE_BRANCHES_UNDECLARED'),
  );
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

export function methodRefusal(err: unknown): HTTPException | null {
  if (err instanceof MethodNotAnnouncedError) {
    return conflict(
      'RELEASE_METHOD_NOT_ANNOUNCED',
      `This run never announced the method it was working from, so nothing says it had one. Clear it with POST /api/projects/{projectId}/release-batches/{runId}/method and a body of {"skill":"${RELEASE_BATCH_SKILL}","loaded":true}, or {"loaded":false,"detail":"<why not>"} if the skill would not load — then call finish again.`,
    );
  }
  if (err instanceof MethodMismatchError) {
    return conflict(
      'RELEASE_METHOD_MISMATCH',
      `This run announced the method \`${err.announced}\` and its job names \`${err.expected}\`. A release working from a method nobody chose for it is not one finish can close; announce \`${err.expected}\`, or abort with what you actually ran.`,
    );
  }
  return null;
}

/**
 * Each refusal under the name the batch route already gives it.
 *
 * One vocabulary across both doors: a caller that learns `RELEASE_PROBES_UNDECLARED`
 * from a batch must not meet a second name for the same fact here.
 */
export function recordRefusal(err: unknown): HTTPException {
  const declined = declarationRefusal(err);
  if (declined) return declined;

  if (err instanceof NoReleaseGateError) {
    return conflict(
      'NO_RELEASE_GATE',
      'This project has no release gate configured, so there is no release to record — an agent `closed` here is already `closed`',
    );
  }
  if (err instanceof ReleaseProbesUndeclaredError) return undeclaredProbes(err);
  if (err instanceof ReleaseProbesUnreadableError) {
    return releaseBlockerHttp(err, 'RELEASE_PROBES_UNREADABLE', { urls: err.urls });
  }
  if (err instanceof ReleaseCheckUnevaluatedError) {
    return releaseBlockerHttp(err, 'RELEASE_CHECK_UNEVALUATED', { check: err.check });
  }
  if (err instanceof ReleaseRosterUnusableError) {
    return releaseBlockerHttp(err, err.code, { waiting: err.waiting });
  }
  if (err instanceof ReleaseNotVerifiedError) {
    return new HTTPException(409, {
      message: err.reason,
      cause: { code: 'RELEASE_NOT_VERIFIED', reason: err.reason, live: err.live },
    });
  }
  if (err instanceof ClaimConflictError) {
    return releaseBlockerHttp(err, 'CLAIM_CONFLICT', { issueIds: err.issueIds });
  }
  if (err instanceof ReleaseRecordMissingError) {
    return releaseBlockerHttp(err, 'RELEASE_RECORD_MISSING', { issueIds: err.issueIds });
  }
  if (err instanceof ReleaseWorkUnmergedError) {
    return releaseBlockerHttp(err, 'RELEASE_WORK_UNMERGED', { issueIds: err.issueIds });
  }
  throw err;
}
