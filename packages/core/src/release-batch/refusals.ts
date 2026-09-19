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
import { ReleaseRunnerAmbiguousError } from './channel.js';
import { ReleaseTargetUndeclaredError } from './gate.js';
import { MethodMismatchError, MethodNotAnnouncedError } from './method.js';
import { RELEASE_BATCH_SKILL } from './plan.js';
import { ReleaseMultiChannelUnsupportedError } from './service.js';
import type { ReleaseRunHoldingError } from './state.js';

export const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const conflict = (code: string, message: string) =>
  new HTTPException(409, { message, cause: { code } });

export const serviceUnavailable = (code: string, message: string) =>
  new HTTPException(503, { message, cause: { code } });

export function declarationRefusal(err: unknown): HTTPException | null {
  if (err instanceof ReleaseTargetUndeclaredError) {
    return conflict('RELEASE_TARGET_UNDECLARED', err.message);
  }
  if (err instanceof ReleaseRunnerAmbiguousError) {
    return conflict('RELEASE_RUNNER_AMBIGUOUS', err.message);
  }
  if (err instanceof ReleaseMultiChannelUnsupportedError) {
    return conflict('RELEASE_MULTI_CHANNEL_UNSUPPORTED', err.message);
  }
  return null;
}
export function undeclaredProbes(): HTTPException {
  return conflict(
    'RELEASE_PROBES_UNDECLARED',
    'One of this project\'s live deploy bindings declares no verification probes, so nothing but the agent\'s own word could say the release happened. Two ways out. Either record where this project is deployed — `environments.live.commitUrl`, the endpoint that reports the running commit, and `environments.live.commitPath`, the dot path to it inside that endpoint\'s JSON body (`commit`, or `data.commit`; leave it empty where the whole body is the commit) — which answers this for every live binding at once. Or declare probes on the binding itself, which overrides the project\'s: `verify` = `{"probes":[{"url":"https://<host>/api/health","commitPath":"commit"}]}`. A binding that declares a `verify` Forge cannot read takes NO project default: correct it or remove it.',
  );
}

export function undeclaredBranches(): HTTPException {
  return conflict(
    'RELEASE_BRANCHES_UNDECLARED',
    'This project declares no baseBranch, so there is nothing a release could promote from',
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
