import { utcMomentWords } from '../lib/elapsed-words.js';
import type { IntegrationDeclaration } from './types.js';

export const ROTATION_WINDOW_MS = 24 * 60 * 60_000;

/** Stored secrets without a previous key and its expiry, which a rotation sets afresh or not at all. */
function withoutPrevious(secrets: Record<string, unknown> | null): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(secrets ?? {}).filter(([k]) => !/^previous[A-Z]/.test(k)),
  );
}

/**
 * The secrets after a new primary credential: every stored and sent field kept, as the drawer
 * sends the key alone (ISS-1421 r19), and the replaced one held for `ROTATION_WINDOW_MS` by a provider
 * that declares a field for it. A stale previous key is never carried into the new record.
 */
export function mergeRotatedSecrets(
  decl: Pick<IntegrationDeclaration, 'schemas'>,
  currentSecrets: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> | null {
  const primaryField = decl.schemas.primaryCredentialField;
  const previousField = decl.schemas.previousCredentialField;
  if (!primaryField) return null;
  const incomingPrimary = incoming[primaryField];
  if (typeof incomingPrimary !== 'string' || incomingPrimary.length === 0) return null;

  const currentPrimary = currentSecrets?.[primaryField];
  const result: Record<string, unknown> = { ...withoutPrevious(currentSecrets), ...incoming };
  // A provider whose previous key nothing reads keeps none (ISS-1421 r20).
  if (previousField && typeof currentPrimary === 'string' && currentPrimary.length > 0) {
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

/**
 * Test connection's Needs re-auth where the new key was refused and the previous one works, saying
 * until when Forge's calls use the previous key (ISS-1421 r20). `subject` names who refused it.
 */
export function newKeyRefused(
  subject: string,
  secrets: { previousTokenExpiresAt?: string | null },
): {
  status: 'needs_reauth';
  message: string;
  diagnostics: { newKeyRefused: true; previousKeyUntil: string };
} {
  const until = String(secrets.previousTokenExpiresAt);
  return {
    status: 'needs_reauth',
    message: `${subject} refused the new key. Forge is still using the previous key until ${utcMomentWords(until)}.`,
    diagnostics: { newKeyRefused: true, previousKeyUntil: until },
  };
}
