import * as Sentry from "@sentry/react";
import { scrubSentryEvent } from "@forge/observability";
import { sourceCommit } from "./source-commit";

// cm:guard the DSN is NEVER hardcoded and Sentry here is opt-in: a source build without `NEXT_PUBLIC_SENTRY_DSN` is a no-op, which is what keeps a contributor who cloned the repo from reporting to the maintainer's instance.
// cm:guard `NEXT_PUBLIC_*` is inlined at BUILD time, so enabling Sentry on a deploy means setting `NEXT_PUBLIC_SENTRY_DSN` as a Coolify BUILD ARG — a runtime environment row reaches the container and leaves the browser's DSN empty.
// cm:edge contract -> packages/observability/src/index.ts — `scrubSentryEvent` is the shared `beforeSend`, so one key list applies in dev, core and web.

let initialized = false;

export function initSentry(): boolean {
  if (initialized) return true;
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    // cm:edge contract -> packages/core/src/observability/sentry.ts — both surfaces name the deploy by bare SHA from one build argument, so an error in the browser and one in the API resolve to the same commit rather than to two ids nothing reconciles.
    release: sourceCommit ?? undefined,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENV ?? "production",
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

/**
 * Manual diagnostic event — sends IMMEDIATELY at `info` level even when no
 * exception was thrown. Used to make otherwise-silent UI paths (e.g. a click
 * that does nothing) observable in Sentry. No-op until `initSentry` succeeds.
 */
export function captureDiag(message: string, extra?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureMessage(message, { level: "info", extra });
}

export { Sentry };
