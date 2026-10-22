/**
 * A secret saved beside the key after a remove (Rocket.Chat's `userId`) leaves a secrets record
 * holding no key, so a stored record is not a held key (ISS-1421 r22).
 */

import { getIntegration } from './registry.js';
import { decryptJson } from './vault.js';

export function keyIn(provider: string, secrets: Record<string, unknown> | null): boolean {
  if (secrets === null) return false;
  const primary = getIntegration(provider)?.schemas.primaryCredentialField;
  if (!primary) return true;
  const key = secrets[primary];
  return typeof key === 'string' && key !== '';
}

/** A record the vault cannot open is not read as holding none. */
export function holdsKey(row: { provider: string; secretsEnc: Buffer | null }): boolean {
  if (row.secretsEnc === null) return false;
  try {
    return keyIn(row.provider, decryptJson<Record<string, unknown>>(row.secretsEnc));
  } catch {
    return true;
  }
}

export function isRemovedConnection(row: {
  provider: string;
  active: boolean;
  secretsEnc: Buffer | null;
}): boolean {
  return !row.active && !holdsKey(row);
}

/** An install comes only from a bound project, so one bound nowhere has no way back (ISS-1421 r23). */
export function turnsBackOnFrom(
  provider: string,
  boundProjectIds: readonly string[],
  askedFrom?: string,
): string {
  const install = getIntegration(provider)?.noKeyTurnsBackOn;
  if (!install) return 'Save a new key to turn it back on.';
  if (askedFrom !== undefined && boundProjectIds.includes(askedFrom)) return install.fromHere;
  if (boundProjectIds.length > 0) return install.fromBound;
  return 'No project is bound to it, so nothing can turn it back on. Clear it from the list under Connections.';
}
