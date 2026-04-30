import * as Sentry from "@sentry/react";
import { scrubSentryEvent } from "@forge/observability";

// Forge ships Sentry as an OPTIONAL telemetry surface. The DSN is never
// hardcoded — official `v0.1.x` release artifacts inject `VITE_SENTRY_DSN`
// at build time via CI secret, and self-hosted users can paste a DSN in
// Settings (stored in config.json, read here at runtime). Source builds
// without either configured become no-ops, so a contributor cloning the
// repo never silently reports to the maintainer's Sentry. Privacy
// scrubbing primitives live in `@forge/observability` so the same key
// list applies in dev, core, and web.

let initialized = false;

export function initSentry(opts: { release: string; dsn?: string | null }): boolean {
  if (initialized) return true;
  // Build-time injection wins for official releases. Runtime override
  // (passed by callers from config.json) lets self-hosted users opt in
  // without rebuilding. Either source missing → SDK never attaches.
  const buildDsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined) || "";
  const dsn = opts.dsn || buildDsn;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    release: `forge-dev@${opts.release}`,
    environment: import.meta.env.DEV ? "development" : "production",
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
