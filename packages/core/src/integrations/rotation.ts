/**
 * ISS-405 — connection-level credential rotation helper.
 *
 * Generalizes the dual-token rotation window that previously lived inline only
 * for Coolify (`apiToken`) so every provider's primary credential keeps the
 * previous value valid for the same overlap window when rotated. Both
 * `integrations/routes.ts` PATCH paths and the adapter-side validity guards go
 * through here, so there's a single source of truth for the window length, the
 * field-name mapping per provider, and the expiry check.
 */

export const ROTATION_WINDOW_MS = 24 * 60 * 60_000;

/** Provider → name of the field that holds the primary (rotating) credential. */
const PRIMARY_FIELD = {
  coolify: 'apiToken',
  postman: 'apiKey',
  epodsystem: 'apiKey',
} as const;

/** Provider → name of the field used to retain the previous credential. */
const PREVIOUS_FIELD = {
  coolify: 'previousApiToken',
  postman: 'previousApiKey',
  epodsystem: 'previousApiKey',
} as const;

export type RotatingProvider = keyof typeof PRIMARY_FIELD;

export function isRotatingProvider(provider: string): provider is RotatingProvider {
  return provider in PRIMARY_FIELD;
}

/**
 * Build the secrets blob to persist when an operator submits a new primary
 * credential. When both an incoming and an existing credential are present, the
 * old credential is retained as `previous<Cred>` with `previousTokenExpiresAt`
 * set to `now + ROTATION_WINDOW_MS` so adapters can fall back during the
 * overlap window. Returns `null` when the caller has no primary credential to
 * write (the route handler then skips the secrets update entirely).
 */
export function mergeRotatedSecrets(
  provider: RotatingProvider,
  currentSecrets: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> | null {
  const primaryField = PRIMARY_FIELD[provider];
  const previousField = PREVIOUS_FIELD[provider];
  const incomingPrimary = incoming[primaryField];
  if (typeof incomingPrimary !== 'string' || incomingPrimary.length === 0) return null;

  const currentPrimary = currentSecrets?.[primaryField];
  const result: Record<string, unknown> = { [primaryField]: incomingPrimary };
  if (typeof currentPrimary === 'string' && currentPrimary.length > 0) {
    result[previousField] = currentPrimary;
    result.previousTokenExpiresAt = new Date(Date.now() + ROTATION_WINDOW_MS).toISOString();
  }
  return result;
}

/**
 * Is the persisted `previousTokenExpiresAt` still in the future? Used by every
 * adapter that needs to decide whether to accept a stored previous credential
 * during the overlap window. A missing timestamp means "no rotation in
 * progress" — treat the previous slot as invalid so callers do not retry with
 * stale credentials.
 */
export function isPreviousCredentialValid(
  secrets: { previousTokenExpiresAt?: string | null } | null | undefined,
): boolean {
  const expiresAt = secrets?.previousTokenExpiresAt;
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return false;
  return parsed > Date.now();
}
