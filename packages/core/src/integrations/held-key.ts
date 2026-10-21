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
