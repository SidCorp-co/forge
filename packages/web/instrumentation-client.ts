import * as Sentry from '@sentry/nextjs';

// Sentry on `forge-web` is opt-in. Set NEXT_PUBLIC_SENTRY_DSN at build/run
// time to enable; leave it unset and the SDK never attaches. Self-hosted
// deployments stay silent by default.
const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || '';

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      // Strip auth headers + tokenized URLs before send. Body fields are
      // less of a concern here (browser JS rarely echoes secrets) but the
      // header path is critical because fetch breadcrumbs include them.
      if (event.request?.headers) {
        for (const k of Object.keys(event.request.headers)) {
          if (['authorization', 'cookie', 'x-device-token'].includes(k.toLowerCase())) {
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

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
