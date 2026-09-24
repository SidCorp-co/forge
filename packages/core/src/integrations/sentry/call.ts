/** One call to Sentry: the ISS-405 previous-token retry, and the refusal or health verdict it earns. */

import { isPreviousCredentialValid } from '../rotation.js';
import { updateConnection } from '../store.js';
import type { AdapterContext, HealthStatus } from '../types.js';
import { SentryRefusal, type SentryRefusalReason } from './refusals.js';
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
      refusal: SentryRefusalReason;
    };

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
    if (res.status === 401) {
      return {
        kind: 'refused',
        status: 401,
        health: 'needs_reauth',
        reason: 'the Sentry auth token was rejected',
        refusal: 'credential_rejected',
      };
    }
    if (res.status === 403) {
      return {
        kind: 'refused',
        status: 403,
        health: 'needs_scope',
        reason: 'the Sentry auth token lacks the scope this call needs (issue:read / issue:write)',
        refusal: 'scope_missing',
      };
    }
    return {
      kind: 'refused',
      status: res.status,
      health: 'error',
      reason: `Sentry answered HTTP ${res.status}`,
      refusal: 'sentry_http_error',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The health write is not bookkeeping: a dispatch that keeps being refused while the connection
 * card stays green is a state that lies about itself, and the healthcheck only runs on its own
 * schedule.
 */
export async function callSentry(
  ctx: SentryAdapterContext,
  url: string,
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
  /** Filled with the response's `Link` header where the caller cares; the other two do not. */
  out?: { link: string | null },
): Promise<unknown> {
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
    throw new SentryRefusal(
      'no_credential',
      'sentry: this connection holds no auth token, so no call can be made',
    );
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
    throw new SentryRefusal('sentry_unreachable', `sentry: ${method} ${url} — ${reason}`);
  }
  await updateConnection(ctx.connectionId, {
    lastHealthStatus: res.kind === 'ok' ? 'ok' : res.health,
    lastHealthAt: new Date(),
  });
  if (res.kind !== 'ok') {
    throw new SentryRefusal(res.refusal, `sentry: ${method} ${url} — ${res.reason}`, {
      httpStatus: res.status,
    });
  }
  if (out) out.link = res.link;
  return res.body;
}
