import * as Sentry from '@sentry/nextjs';
import { scrubSentryEvent } from '@forge/observability';

// Sentry on `forge-web` is opt-in. Set NEXT_PUBLIC_SENTRY_DSN at build/run
// time to enable; leave it unset and the SDK never attaches. Privacy
// scrubber comes from `@forge/observability` so the same key set applies
// across dev / core / web.
const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || '';

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
