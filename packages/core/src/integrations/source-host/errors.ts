/**
 * Why a project's source host cannot be reached, and how a call to one failed. Host-neutral, so a
 * reader branches on the reason rather than on which host raised it.
 */

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

/** The caller asked the host for something it does not have — a verb or a shape. Refused by name. */
export class SourceHostInputRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceHostInputRefusal';
  }
}
