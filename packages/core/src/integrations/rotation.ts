/**
 * ISS-405 — connection-level credential rotation helper.
 *
 * Generalizes the dual-token rotation window that once lived inline for Coolify (`apiToken`) so
 * every provider's primary credential keeps the previous value valid for the same overlap window
 * when rotated. Both PATCH paths and the adapter-side validity guards go through here, so there is
 * a single source of truth for the window length and the expiry check.
 *
 * ISS-1071 took the two per-provider field tables out of this file. Which field holds a provider's
 * rotating credential is a fact about that provider, so it is declared on the provider — this
 * module is the mechanism and knows no provider's name.
 */

import type { IntegrationDeclaration } from './types.js';

export const ROTATION_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Build the secrets blob to persist when an operator submits a new primary credential.
 *
 * When both an incoming and an existing credential are present, the old one is retained under the
 * provider's declared previous-credential field with `previousTokenExpiresAt` set to
 * `now + ROTATION_WINDOW_MS`, so adapters can fall back during the overlap window. Returns `null`
 * when the caller has no primary credential to write, or when the provider declares none — the
 * route handler then skips the secrets update entirely.
 */
export function mergeRotatedSecrets(
  decl: Pick<IntegrationDeclaration, 'schemas'>,
  currentSecrets: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> | null {
  const primaryField = decl.schemas.primaryCredentialField;
  const previousField = decl.schemas.previousCredentialField;
  if (!primaryField || !previousField) return null;
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
