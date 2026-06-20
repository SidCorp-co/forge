import * as Sentry from "@sentry/react";
import { scrubSentryEvent } from "@forge/observability";

// web-v2 ships Sentry as an OPTIONAL telemetry surface (the forge-web project on
// the maintainer's self-hosted instance). The DSN is NEVER hardcoded: it is read
// from the build-time public env `NEXT_PUBLIC_SENTRY_DSN`. Source builds without
// it become no-ops, so a contributor cloning the repo never silently reports to
// the maintainer's Sentry. Privacy scrubbing primitives live in
// `@forge/observability` so the same key list applies in dev, core, and web.
//
// NOTE: `NEXT_PUBLIC_*` is inlined at BUILD time — to enable Sentry on a deploy,
// set `NEXT_PUBLIC_SENTRY_DSN` in the web-v2 build environment (Coolify), not at
// runtime.

let initialized = false;

export function initSentry(): boolean {
  if (initialized) return true;
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    release: process.env.NEXT_PUBLIC_APP_VERSION
      ? `forge-web@${process.env.NEXT_PUBLIC_APP_VERSION}`
      : undefined,
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
