import * as Sentry from '@sentry/node';
import { scrubSentryEvent } from '@forge/observability';
import pkg from '../../package.json' with { type: 'json' };

// Sentry is opt-in for `@forge/core`. Set `SENTRY_DSN` in the runtime
// environment to enable; leave it unset and the SDK never attaches.
// Self-hosted operators stay silent by default — no maintainer
// telemetry from contributor / on-prem deployments. Privacy primitives
// (scrubbed header / body keys, URL token regex) come from
// `@forge/observability` so the same contract applies across surfaces.

let initialized = false;

export function initSentry(): boolean {
  if (initialized) return true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    release: `forge-core@${pkg.version}`,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
  });
  initialized = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export { Sentry };
