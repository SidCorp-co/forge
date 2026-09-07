import { scrubSentryEvent } from '@forge/observability';
import * as Sentry from '@sentry/node';
import { sourceCommit } from './source-commit.js';

// cm:guard Sentry is opt-in and `SENTRY_DSN` unset means the SDK never attaches — that absence IS the privacy contract for self-hosted and contributor deployments, so no default DSN may be added here or shipped in a config file, and a maintainer box is the only thing that ever reports.
// cm:edge contract -> packages/observability/src/index.ts — `scrubSentryEvent` is the `beforeSend` on every surface, so the scrubbed header/body key list and the URL token regex are one contract across core, web and desktop; a surface that sets its own `beforeSend` leaves that contract without anything saying so.

let initialized = false;

export function initSentry(): boolean {
  if (initialized) return true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    // cm:edge contract -> packages/core/src/health/routes.ts — the same `sourceCommit` this route serves, so an operator comparing a Sentry release to `/version` is comparing one value to itself. Bare SHA, no `forge-core@` prefix: this DSN's project already separates the surface, and a release whose version IS the commit is what Sentry resolves against the linked repository.
    // cm:why `undefined` rather than a fallback: it is how the SDK reads "no release", and a build that cannot name its commit must attach none — a package version here names hundreds of deploys as one release and leaves suspect-commit resolution nothing to resolve.
    release: sourceCommit ?? undefined,
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
