/**
 * A healthcheck's sentence as said (`@forge/contracts/said`): the adapter's own words by key, so a
 * page reads them in its language, and what a provider or a thrown error wrote verbatim, shown as
 * written. `message` stays the English the plugin and the API have always read.
 */

import { type Said, say, sayEn, verbatim } from '@forge/contracts/said';
import type { HealthCheckResult, HealthStatus } from './types.js';

/** A result carrying `says` and its English as `message`; no sentence, neither field. */
export function healthOf(
  status: HealthStatus,
  says?: Said,
  diagnostics?: Record<string, unknown>,
): HealthCheckResult {
  return {
    status,
    ...(says ? { message: sayEn(says), says: { message: says } } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

/**
 * What a thrown error says, as its thrower wrote it. A throw that is not an `Error` is its string
 * form, or with `opaque` the unknown error it was always reported as.
 */
export function thrownSaid(err: unknown, opaque = false): Said {
  if (err instanceof Error) return verbatim(err.message);
  return opaque ? say('integrations.health.unknownError') : verbatim(String(err));
}
