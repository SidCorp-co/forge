import * as Sentry from "@sentry/react";

// Forge ships Sentry as an OPTIONAL telemetry surface. The DSN is never
// hardcoded — official `v0.1.x` release artifacts inject `VITE_SENTRY_DSN`
// at build time via CI secret, and self-hosted users can paste a DSN in
// Settings (stored in config.json, read here at runtime). Source builds
// without either configured become no-ops, so a contributor cloning the
// repo never silently reports to the maintainer's Sentry.

const SCRUB_HEADER_KEYS = ["authorization", "x-device-token", "cookie"];
const SCRUB_BODY_KEYS = [
  "authToken",
  "auth_token",
  "apiKey",
  "api_key",
  "password",
  "jwt",
  "token",
];
const URL_TOKEN_PATTERN = /([?&](?:token|jwt|access_token|api_key)=)[^&#]+/gi;

function scrubObject(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (SCRUB_BODY_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())) {
      (obj as Record<string, unknown>)[key] = "[Filtered]";
    }
  }
}

function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  const req = event.request;
  if (req?.headers) {
    for (const k of Object.keys(req.headers)) {
      if (SCRUB_HEADER_KEYS.includes(k.toLowerCase())) {
        req.headers[k] = "[Filtered]";
      }
    }
  }
  if (req?.url) {
    req.url = req.url.replace(URL_TOKEN_PATTERN, "$1[Filtered]");
  }
  if (req?.data) {
    if (typeof req.data === "string") {
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
  // Breadcrumb URLs (fetch/xhr) can contain tokens too.
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (b.data && typeof b.data === "object") {
        if (typeof (b.data as { url?: string }).url === "string") {
          (b.data as { url: string }).url = (b.data as { url: string }).url.replace(
            URL_TOKEN_PATTERN,
            "$1[Filtered]",
          );
        }
        scrubObject(b.data);
      }
    }
  }
  return event;
}

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
    beforeSend: scrub,
  });
  initialized = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export { Sentry };
