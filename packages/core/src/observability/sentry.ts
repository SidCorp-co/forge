import * as Sentry from '@sentry/node';

// Sentry is opt-in for `@forge/core`. Set `SENTRY_DSN` in the runtime
// environment to enable; leave it unset and the SDK never attaches.
// Self-hosted operators stay silent by default — no maintainer telemetry
// from contributor / on-prem deployments.

const SCRUB_HEADER_KEYS = new Set(['authorization', 'x-device-token', 'cookie', 'x-api-key']);
const SCRUB_BODY_KEYS = new Set([
  'authToken',
  'auth_token',
  'apiKey',
  'api_key',
  'password',
  'jwt',
  'token',
  'refreshToken',
  'refresh_token',
]);
const URL_TOKEN_PATTERN = /([?&](?:token|jwt|access_token|api_key)=)[^&#]+/gi;

function scrubObject(obj: unknown): void {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if ([...SCRUB_BODY_KEYS].some((k) => k.toLowerCase() === lower)) {
      (obj as Record<string, unknown>)[key] = '[Filtered]';
    }
  }
}

function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  const req = event.request;
  if (req?.headers) {
    for (const k of Object.keys(req.headers)) {
      if (SCRUB_HEADER_KEYS.has(k.toLowerCase())) {
        req.headers[k] = '[Filtered]';
      }
    }
  }
  if (req?.url) {
    req.url = req.url.replace(URL_TOKEN_PATTERN, '$1[Filtered]');
  }
  if (req?.data) {
    if (typeof req.data === 'string') {
      try {
        const parsed = JSON.parse(req.data);
        scrubObject(parsed);
        req.data = JSON.stringify(parsed);
      } catch {
        // not JSON — leave as-is
      }
    } else {
      scrubObject(req.data);
    }
  }
  return event;
}

let initialized = false;

export function initSentry(opts: { release: string }): boolean {
  if (initialized) return true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    release: `forge-core@${opts.release}`,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrub,
  });
  initialized = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export { Sentry };
