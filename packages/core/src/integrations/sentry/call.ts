/** One call to Sentry: the ISS-405 previous-token retry, and the refusal or health verdict it earns. */

import type { SentryRefusalCode } from '@forge/contracts/integrations';
import type { RefusalError } from '../../lib/refusal.js';
import type { AdapterContext, HealthStatus } from '../index.js';
import { isPreviousCredentialValid, updateConnection } from '../index.js';
import { refuseSentry } from './refusals.js';
import type { SentryConfig, SentrySecrets } from './types.js';

const CALL_TIMEOUT_MS = 15_000;

export type SentryAdapterContext = AdapterContext<SentryConfig, SentrySecrets>;

type Attempt =
  | { kind: 'ok'; body: unknown; link: string | null }
  | {
      kind: 'refused';
      status: number;
      health: HealthStatus;
      reason: string;
      refusal: SentryRefusalCode;
    };

/**
 * The one reading of a Sentry refusal, for dispatches and the healthcheck alike: Sentry answers a bad
 * token with 401 and a token missing a scope with 403.
 */
function classifySentryStatus(status: number): {
  health: HealthStatus;
  reason: string;
  refusal: SentryRefusalCode;
} {
  if (status === 401) {
    return {
      health: 'needs_reauth',
      reason: 'the Sentry auth token was rejected',
      refusal: 'SENTRY_CREDENTIAL_REJECTED',
    };
  }
  if (status === 403) {
    return {
      health: 'needs_scope',
      reason:
        'the Sentry auth token lacks the scope this call needs (issue:read / issue:write, org:read for the healthcheck)',
      refusal: 'SENTRY_SCOPE_MISSING',
    };
  }
  return {
    health: 'error',
    reason: `Sentry answered HTTP ${status}`,
    refusal: 'SENTRY_HTTP_ERROR',
  };
}

/** The connection health a refusal recorded; anything not about the token is an `error`. */
export function sentryRefusalHealth(reason: SentryRefusalCode): HealthStatus {
  return reason === 'SENTRY_CREDENTIAL_REJECTED'
    ? 'needs_reauth'
    : reason === 'SENTRY_SCOPE_MISSING'
      ? 'needs_scope'
      : 'error';
}

async function attempt(
  url: string,
  token: string,
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (res.ok) return { kind: 'ok', body: await res.json(), link: res.headers.get('link') };
    return { kind: 'refused', status: res.status, ...classifySentryStatus(res.status) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The health write is not bookkeeping: a dispatch that keeps being refused while the connection
 * card stays green is a state that lies about itself, and the healthcheck only runs on its own
 * schedule.
 */
export type SentryOutcome =
  | { ok: true; body: unknown; link: string | null }
  | {
      ok: false;
      refusal: RefusalError;
      /** Sentry's own status where the call got that far; null where it never did. */
      httpStatus: number | null;
    };

/** The call and the health write it earns, its refusal returned rather than thrown. */
export async function callSentryOutcome(
  ctx: SentryAdapterContext,
  url: string,
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
): Promise<SentryOutcome> {
  const authToken = ctx.secrets?.authToken;
  if (!authToken) {
    // The same rule the catch below states, at the one refusal that precedes it: a connection left
    // green through a call that could not be made is a state that lies about itself. `healthcheck`
    // in `adapter.ts` writes `error` for this exact condition, and a dispatch that stayed silent
    // here would leave the card disagreeing with the delivery log beside it.
    await updateConnection(ctx.connectionId, {
      lastHealthStatus: 'error',
      lastHealthAt: new Date(),
    });
    return {
      ok: false,
      refusal: refuseSentry(
        'SENTRY_NO_CREDENTIAL',
        'sentry: this connection holds no auth token, so no call can be made',
      ),
      httpStatus: null,
    };
  }
  let res: Attempt;
  try {
    res = await attempt(url, authToken, method, body);
    if (
      res.kind === 'refused' &&
      res.status === 401 &&
      ctx.secrets.previousAuthToken &&
      isPreviousCredentialValid(ctx.secrets)
    ) {
      res = await attempt(url, ctx.secrets.previousAuthToken, method, body);
    }
  } catch (err) {
    // A timeout, a DNS failure or a body that is not JSON never produced an HTTP status, so it
    // never reached the verdict below — and a connection left green through a call that could not
    // be made is the contradiction this function exists to prevent.
    await updateConnection(ctx.connectionId, {
      lastHealthStatus: 'error',
      lastHealthAt: new Date(),
    });
    const reason = err instanceof Error ? err.message : 'unknown error';
    return {
      ok: false,
      refusal: refuseSentry(
        'SENTRY_UNREACHABLE',
        `sentry: could not reach Sentry — ${method} ${url} — ${reason}`,
      ),
      httpStatus: null,
    };
  }
  await updateConnection(ctx.connectionId, {
    lastHealthStatus: res.kind === 'ok' ? 'ok' : res.health,
    lastHealthAt: new Date(),
  });
  if (res.kind !== 'ok') {
    return {
      ok: false,
      refusal: refuseSentry(res.refusal, `sentry: ${method} ${url} — ${res.reason}`),
      httpStatus: res.status,
    };
  }
  return { ok: true, body: res.body, link: res.link };
}

export async function callSentry(
  ctx: SentryAdapterContext,
  url: string,
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
  /** Filled with the response's `Link` header where the caller cares; the other two do not. */
  out?: { link: string | null },
): Promise<unknown> {
  const outcome = await callSentryOutcome(ctx, url, method, body);
  if (!outcome.ok) throw outcome.refusal;
  if (out) out.link = outcome.link;
  return outcome.body;
}
