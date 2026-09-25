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
  blockersOf,
  RELEASE_ROSTER_LIMIT,
  type ReleaseBlockerCode,
  releaseBlockerSentence,
} from './blocker-sentences.js';
import { ReleaseRunnerAmbiguousError } from './channel.js';
import {
  ClaimConflictError,
  NoReleaseGateError,
  ReleaseBatchAbortedError,
  ReleaseFinishedForOtherCommitError,
  ReleaseFinishInFlightError,
  ReleaseNotVerifiedError,
  ReleaseProbesUndeclaredError,
  ReleaseVersionMissingError,
} from './errors.js';
import { ReleaseTargetUndeclaredError } from './gate.js';
import { MethodMismatchError, MethodNotAnnouncedError } from './method.js';
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

export function issuesUnnamed(projectId: string): HTTPException {
  return new HTTPException(400, {
    message:
      `This call names no issue to release, and issues are waiting at the release gate. Send the ids GET /api/projects/${projectId}/release-batches/roster lists, oldest merge first, at most ` +
      `${RELEASE_ROSTER_LIMIT} in one release.`,
    cause: { code: 'RELEASE_ISSUES_UNNAMED' },
  });
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
    const { projectId, runId } = err.where;
    return conflict(
      'RELEASE_METHOD_NOT_ANNOUNCED',
      `This run never announced the method it was working from, so nothing says it had one. Clear it with POST /api/projects/${projectId}/release-batches/${runId}/method and a body of {"skill":"${err.expected}","loaded":true}, or {"loaded":false,"detail":"<why not>"} if the skill would not load — then call finish again.`,
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
  const reported = reportedRefusal(err);
  if (reported) return reported;
  const declined = declarationRefusal(err);
  if (declined) return declined;

  if (err instanceof NoReleaseGateError) {
    return conflict(
      'NO_RELEASE_GATE',
      'This project has no release gate configured, so there is no release to record — an agent `closed` here is already `closed`',
    );
  }
  if (err instanceof ReleaseProbesUndeclaredError) return undeclaredProbes(err);
  if (err instanceof ReleaseNotVerifiedError) {
    return new HTTPException(409, {
      message: err.reason,
      cause: { code: 'RELEASE_NOT_VERIFIED', reason: err.reason, live: err.live },
    });
  }
  if (err instanceof ClaimConflictError) {
    return releaseBlockerHttp(err, 'CLAIM_CONFLICT', { issueIds: err.issueIds });
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
  if (err instanceof ReleaseProbesUndeclaredError) return undeclaredProbes(err);
  if (err instanceof ReleaseVersionMissingError) {
    return conflict('RELEASE_VERSION_MISSING', err.message);
  }
  if (err instanceof ReleaseBatchAbortedError) {
    return conflict(
      'RELEASE_BATCH_ABORTED',
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
  return methodRefusal(err);
}

/** Which commit a finished batch verified, against the one a later finish names; both doors say it. */
export function finishedForSentence(err: ReleaseFinishedForOtherCommitError): string {
  const verified =
    err.finishedCommit === null
      ? 'finished with no named commit, on a live build that had changed from what was serving when it opened'
      : `finished for ${err.finishedCommit}`;
  return `This batch already ${verified}, and this call names ${err.askedCommit}, which that finish never verified. A finished batch is not verified again, so its issues' closes say nothing about ${err.askedCommit}; a release of ${err.askedCommit} is a batch of its own.`;
}

/** What a finish on an aborted batch is told, by what the abort did to that batch. */
export function abortedSentence(err: ReleaseBatchAbortedError): string {
  const none = 'This batch was aborted, so there is nothing left to finish';
  const closed = err.closed ?? [];
  const kept = closed.length > 0 ? ` ${closedBeforeAbort(closed)}` : '';
  switch (err.account) {
    case 'shipped':
      return `${none}: its release had already shipped, so the issues its finish closed stay closed, and the abort moved none of them.`;
    case 'held': {
      const rest = closed.length > 0 ? 'Every other issue stays' : 'Its issues stay';
      // `release-records` takes only issues at the gate that no batch claims, so the abort that
      // puts them there comes first and is never offered beside it.
      return `${none}: it recorded a promotion, so the abort kept its claims.${kept} ${rest} at \`releasing\`, still claimed, for a person to settle. To settle them, abort this batch again with \`promotedRoster: "return-to-gate"\`, which puts them back at the release gate; once they are there, if the release did land, record it with POST /api/projects/${err.projectId}/release-records, naming the commit production is serving.`;
    }
    case 'returning':
      return `${none}. The abort had not finished putting its roster back at the release gate when this was read, so each issue’s own status says whether its claim is released yet.`;
    case 'released':
      if (closed.length > 0) {
        return `${none}.${kept} Its claims were released and the rest of its roster is back where the abort put it. If the release did land after all, that is a person’s call to make on each of those.`;
      }
      return `${none}: its claims were released and its roster is back where the abort put it. If the release did land after all, that is a person’s call to make on each issue.`;
    case 'unrecorded':
      return 'This batch’s run was cancelled, so there is nothing left to finish. Nothing on the run records what that did to its issues, so each issue’s own status and notes are the account; if the release did land after all, that is a person’s call to make on each issue.';
  }
}

/** The issues a finish closed before the abort landed, which the abort did not move. */
function closedBeforeAbort(ids: string[]): string {
  const one = ids.length === 1;
  return `Its finish had already closed ${one ? 'issue' : 'issues'} ${ids.join(', ')} before the abort, and ${one ? 'it stays' : 'they stay'} closed.`;
}
