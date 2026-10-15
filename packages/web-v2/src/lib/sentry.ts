import * as Sentry from "@sentry/react";
import { SENTRY_DATA_COLLECTION, scrubSentryEvent } from "@forge/observability";
import { sourceCommit } from "./source-commit";


let initialized = false;

export function initSentry(): boolean {
  if (initialized) return true;
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    release: sourceCommit ?? undefined,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENV ?? "production",
    tracesSampleRate: 0,
    dataCollection: SENTRY_DATA_COLLECTION,
    attachStacktrace: false,
    beforeSend: scrubSentryEvent,
  });
  initialized = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export function captureDiag(message: string, extra?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureMessage(message, { level: "info", extra });
}

export { Sentry };
