import * as Sentry from '@sentry/nextjs';
import { scrubSentryEvent } from '@forge/observability';

// Server / edge Sentry init runs through Next's `register()` hook so it
// fires before any other server-side module gets a chance to throw at
// import. SENTRY_DSN missing → no-op. Privacy scrubber is the shared
// `@forge/observability` adapter — same contract as dev + core.

export async function register() {
  const DSN = process.env.SENTRY_DSN || '';
  if (!DSN) return;

  const baseOpts = {
    dsn: DSN,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
  };

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init(baseOpts);
  } else if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init(baseOpts);
  }
}

export const onRequestError = Sentry.captureRequestError;
