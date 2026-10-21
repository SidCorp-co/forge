/**
 * Why a check never reached its provider, read off what the HTTP client threw (ISS-1421 r15). A
 * host that does not resolve answered "Forge could not check Coolify. It said: Fetch failed.": the
 * client's own text, put in a provider's mouth that never opened. The reason is said in Forge's
 * words instead, and the client's text stays in the answer's diagnostics.
 */

export type UnreachedReason =
  | 'host_unresolved'
  | 'refused'
  | 'timed_out'
  | 'certificate'
  | 'reset'
  | 'unreachable';

export interface Unreached {
  reason: UnreachedReason;
  /** The system's own code for it (`ENOTFOUND`, `ECONNREFUSED`…), where one was given. */
  code: string | null;
}

const BY_CODE: ReadonlyArray<[RegExp, UnreachedReason]> = [
  [/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)$/, 'host_unresolved'],
  [/^(ECONNREFUSED)$/, 'refused'],
  [
    /^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/,
    'timed_out',
  ],
  [/CERT|^ERR_TLS|^ERR_SSL|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/, 'certificate'],
  [/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/, 'reset'],
  [/^(EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENETDOWN)$/, 'unreachable'],
];

function codeOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const own = (value as { code?: unknown }).code;
  if (typeof own === 'string') return own;
  // Node wraps a connection tried on several addresses in an AggregateError.
  const errors = (value as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      const code = codeOf(e);
      if (code) return code;
    }
  }
  return null;
}

/** What kept a request from its host, or null where the error is not a transport failure. */
export function unreachedBy(err: unknown): Unreached | null {
  if (!(err instanceof Error)) return null;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return { reason: 'timed_out', code: err.name };
  }
  const code = codeOf(err.cause) ?? codeOf(err);
  if (code) {
    for (const [pattern, reason] of BY_CODE) if (pattern.test(code)) return { reason, code };
  }
  // undici's own failure to fetch, with a cause it did not name.
  if (err.name === 'TypeError' && /^fetch failed$/i.test(err.message)) {
    return { reason: 'unreachable', code };
  }
  return null;
}

const BECAUSE: Readonly<Record<UnreachedReason, string>> = {
  host_unresolved: 'its host name does not resolve',
  refused: 'nothing accepted the connection at its address',
  timed_out: 'no answer came in time',
  certificate: 'its certificate was not accepted',
  reset: 'the connection was cut before it answered',
  unreachable: 'the connection to its address failed',
};

const REASONS = new Set<string>(Object.keys(BECAUSE));

/** Why a request never reached its host, as the clause after "because". */
export function unreachedBecause(reason: UnreachedReason): string {
  return BECAUSE[reason];
}

export function unreachedWords(label: string, reason: UnreachedReason): string {
  const check =
    reason === 'timed_out'
      ? 'Check that the address on this connection is right and answering, then test again.'
      : 'Check the address saved on this connection, then test again.';
  return `Forge could not reach ${label}, because ${BECAUSE[reason]}. ${check}`;
}

export function isUnreachedReason(value: unknown): value is UnreachedReason {
  return typeof value === 'string' && REASONS.has(value);
}

/**
 * The diagnostics a check's catch-all reports a thrown error under: why the host was not reached,
 * or `thrown` where the error came from somewhere else and the provider never answered.
 */
export function thrownDiagnostics(err: unknown): Record<string, unknown> {
  const unreached = unreachedBy(err);
  if (!unreached) return { thrown: true };
  return {
    unreached: unreached.reason,
    ...(unreached.code ? { unreachedCode: unreached.code } : {}),
  };
}
