// The rate-limit answer a source host sends with each response, kept on the lines that log a call
// so a 429 on core's shared egress address is attributed to the caller that drew it.

const RATE_HEADERS = [
  'ratelimit-name',
  'ratelimit-limit',
  'ratelimit-observed',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
] as const;

/** A host's rate-limit headers on an answer (GitLab's names), as sent; absent ones are left out. */
export function rateLimitHeadersOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RATE_HEADERS) {
    const v = headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}
