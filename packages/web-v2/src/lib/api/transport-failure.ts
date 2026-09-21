
import * as Sentry from '@sentry/react';

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
