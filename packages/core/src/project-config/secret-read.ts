// The project's own secrets, read by core for a fire core runs itself (ISS-923: the `beta_port`
// schedule's forge-beta address and token). Each named ref answers its value, or why there is none,
// by name: never a value guessed and never one read from anywhere but this project's vault.

import { decryptSecret } from '../integrations/index.js';
import { drizzleConfigStore } from './store.js';

export type ProjectSecretRead =
  | { ok: true; values: Map<string, string> }
  | { ok: false; code: 'SECRET_VALUE_MISSING' | 'SECRET_VALUE_UNREADABLE'; refs: string[] };

/** The decrypted value of each ref (`<scope>/<name>`); every missing or undecryptable ref named. */
export async function readProjectSecrets(
  projectId: string,
  refs: readonly string[],
): Promise<ProjectSecretRead> {
  const stored = await drizzleConfigStore.secretValues(projectId, refs);
  const missing = refs.filter((r) => !stored.has(r));
  if (missing.length > 0) return { ok: false, code: 'SECRET_VALUE_MISSING', refs: missing };
  const values = new Map<string, string>();
  const unreadable: string[] = [];
  for (const ref of refs) {
    try {
      values.set(ref, decryptSecret(stored.get(ref) as Buffer));
    } catch {
      unreadable.push(ref);
    }
  }
  if (unreadable.length > 0)
    return { ok: false, code: 'SECRET_VALUE_UNREADABLE', refs: unreadable };
  return { ok: true, values };
}
