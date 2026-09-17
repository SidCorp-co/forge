/**
 * The one thing the browser knows that the server cannot: the request never
 * arrived.
 *
 * Core reports its own failures — `middleware/error.ts` captures every error a
 * route throws, handled or not, with a request id, a stack and the release SHA.
 * So a 4xx or 5xx reported again from here is a second issue with less context
 * than the first, which is the duplicate-reporting anti-pattern rather than
 * more observability.
 *
 * What core CANNOT see is a request that never reached it: a CORS rejection, a
 * DNS failure, a TLS error, a chunk that no longer exists on the origin. The
 * browser collapses all of those into one opaque `TypeError`, and until this
 * module existed they reached nobody — measured 2026-09-17, `forge-web` had
 * taken zero events in 90 days while the DSN ingested a test event in seconds,
 * and a real user's failed chat send (forge-dev ISS-1084) had to be diagnosed
 * by guesswork because no record of it existed anywhere.
 */

import * as Sentry from '@sentry/react';

/**
 * Why a rejected `fetch` may still not be worth an issue.
 *
 * Only report what someone would act on. These two are the caller's own doing
 * or the user's network, not a defect on our side.
 */
// cm:guard the browser does NOT distinguish CORS from DNS from TLS — all three arrive as the same opaque `TypeError: Failed to fetch`, by design, so nothing here may claim to have classified them. The tag says `unreachable` and the context carries what IS known (url, method, online flag); a tag asserting `cors` would be a guess wearing a fact's clothes.
function skipReason(err: unknown): string | null {
  if (err instanceof DOMException && err.name === 'AbortError') return 'aborted';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  return null;
}

/**
 * Report a transport failure, or say why it was not reported.
 *
 * Returns what it decided so a test can assert the decision rather than the
 * side effect.
 */
// cm:guard called ONLY around the `fetch` call itself, never around the response handling. That placement is what makes "core already reported this" structural instead of a condition someone has to remember: an `ApiError` is built after `fetch` resolves, so it cannot reach here at all.
export function reportTransportFailure(
  err: unknown,
  request: { url: string; method: string },
): 'reported' | 'aborted' | 'offline' {
  const skip = skipReason(err);
  if (skip !== null) return skip as 'aborted' | 'offline';

  Sentry.captureException(err, {
    tags: { area: 'api-transport', outcome: 'unreachable', http_method: request.method },
    contexts: {
      forge_request: {
        url: request.url,
        method: request.method,
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      },
    },
  });
  return 'reported';
}
