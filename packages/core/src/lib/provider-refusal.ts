/**
 * A provider that refused or could not answer, said to the caller as 424 with its refusal intact.
 * Never 502 or 504: Cloudflare in front of a deployed core swaps either for its own HTML page, so
 * the person reads "Bad gateway" instead of what the provider said. A window the provider named for
 * trying again rides along as `Retry-After`.
 */

import { HTTPException } from 'hono/http-exception';

export const PROVIDER_REFUSAL_STATUS = 424;

export function providerRefused(
  message: string,
  code: string,
  opts: { details?: unknown; retryAt?: Date | null } = {},
): HTTPException {
  const retryAfter = opts.retryAt
    ? Math.max(1, Math.ceil((opts.retryAt.getTime() - Date.now()) / 1000))
    : undefined;
  return new HTTPException(PROVIDER_REFUSAL_STATUS, {
    message,
    cause: {
      code,
      ...(opts.details === undefined ? {} : { details: opts.details }),
      ...(retryAfter === undefined ? {} : { retryAfter }),
    },
  });
}
