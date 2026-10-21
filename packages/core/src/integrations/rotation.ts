import type { IntegrationDeclaration } from './types.js';

export const ROTATION_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The secrets after a new primary credential: every stored and sent field kept, as the drawer
 * sends the key alone (ISS-1421 r19), and the replaced one held for `ROTATION_WINDOW_MS`.
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
  const result: Record<string, unknown> = { ...currentSecrets, ...incoming };
  if (typeof currentPrimary === 'string' && currentPrimary.length > 0) {
    result[previousField] = currentPrimary;
    result.previousTokenExpiresAt = new Date(Date.now() + ROTATION_WINDOW_MS).toISOString();
  }
  return result;
}

export function isPreviousCredentialValid(
  secrets: { previousTokenExpiresAt?: string | null } | null | undefined,
): boolean {
  const expiresAt = secrets?.previousTokenExpiresAt;
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return false;
  return parsed > Date.now();
}
