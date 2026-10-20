
import * as Sentry from '@sentry/react';

/** The sentence every screen says where the browser could not reach Forge at all, never the browser's
 *  own words such as "Failed to fetch (host)", which differ by browser and name no next step (ISS-1228). */
export const UNREACHABLE_SENTENCE = 'Forge could not be reached. Check your connection, then try again.';

const unreachable = new WeakSet<object>();

/** Mark a rejection the request never got an answer for, keeping the very error the caller sees. */
export function markUnreachable(err: unknown): void {
  if (typeof err !== 'object' || err === null) return;
  if (err instanceof DOMException && err.name === 'AbortError') return;
  unreachable.add(err);
}

/** Whether this error is a request that never reached Forge, as the client marked it. */
export function isUnreachable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && unreachable.has(err);
}

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
