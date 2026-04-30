import * as Sentry from '@sentry/nextjs';

// Server / edge Sentry init runs through Next's `register()` hook so it
// fires before any other server-side module gets a chance to throw at
// import. SENTRY_DSN missing → no-op.

export async function register() {
  const DSN = process.env.SENTRY_DSN || '';
  if (!DSN) return;

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({
      dsn: DSN,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      tracesSampleRate: 0,
      sendDefaultPii: false,
      beforeSend(event) {
        const SCRUB_HEADERS = new Set(['authorization', 'cookie', 'x-device-token', 'x-api-key']);
        if (event.request?.headers) {
          for (const k of Object.keys(event.request.headers)) {
            if (SCRUB_HEADERS.has(k.toLowerCase())) {
              event.request.headers[k] = '[Filtered]';
            }
          }
        }
        if (event.request?.url) {
          event.request.url = event.request.url.replace(
            /([?&](?:token|jwt|access_token|api_key)=)[^&#]+/gi,
            '$1[Filtered]',
          );
        }
        return event;
      },
    });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init({
      dsn: DSN,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
  }
}

export const onRequestError = Sentry.captureRequestError;
