/**
 * Why a project's source host cannot be reached, and how a call to one failed. Host-neutral, so a
 * reader branches on the reason rather than on which host raised it.
 */

import type { IntegrationRefusalCode } from '@forge/contracts/integrations';
import { type RefusalError, refuser } from '../../lib/refusal.js';

type SourceHostRefusalReason =
  | 'no_binding'
  | 'binding_disabled'
  | 'not_granted'
  | 'host_mismatch'
  | 'local_repository'
  | 'no_repository'
  | 'no_installation'
  | 'no_connection'
  | 'no_credential';

export class SourceHostUnavailable extends Error {
  readonly reason: SourceHostRefusalReason;
  readonly bindingId: string | null;
  constructor(reason: SourceHostRefusalReason, message: string, bindingId: string | null = null) {
    super(message);
    this.name = 'SourceHostUnavailable';
    this.reason = reason;
    this.bindingId = bindingId;
  }
}

/** The host refused or failed a request. `phase: 'mint'` is the credential, not the path asked. */
export class SourceHostCallError extends Error {
  readonly status: number;
  readonly detail: string | null;
  readonly phase: 'mint' | 'request';
  /** When the host said a refused call may be tried again, where it named one (a rate limit). */
  retryAt: Date | null = null;
  constructor(
    status: number,
    message: string,
    detail: string | null = null,
    phase: 'mint' | 'request' = 'request',
  ) {
    super(message);
    this.name = 'SourceHostCallError';
    this.status = status;
    this.detail = detail;
    this.phase = phase;
  }
}

const refuseHostInput = refuser<IntegrationRefusalCode>('SOURCE_HOST_INPUT_REFUSED');

/** The caller asked the host for something it does not have — a verb or a shape. Refused by name. */
export function refuseSourceHostInput(detail: string): RefusalError {
  return refuseHostInput('SOURCE_HOST_INPUT_REFUSED', detail);
}

const refuseCheck = refuser<IntegrationRefusalCode>('SOURCE_HOST_INPUT_REFUSED');

/**
 * A check id sent to the route that takes the other kind: a GitLab pipeline id to a job's log, or a
 * job id to a pipeline's jobs. Refused by name, with the route that takes it, never a host 404.
 */
export function refuseCheckIdKind(
  code: 'CHECK_ID_IS_A_PIPELINE' | 'CHECK_ID_IS_A_JOB',
  detail: string,
): RefusalError {
  return refuseCheck(code, detail);
}
