import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationBindings } from '../db/schema.js';
import { encryptSecret, isVaultConfigured } from '../integrations/index.js';

/**
 * Boot: every inbound webhook secret still resting as plaintext (written before 0404) is encrypted
 * with the integration vault and its plaintext nulled. Refuses to boot, naming the key, when such a
 * row exists and no INTEGRATION_MASTER_KEY is set. Returns how many rows it converted.
 */
export async function encryptPlaintextBindingSecrets(): Promise<number> {
  const rows = await db
    .select({ id: integrationBindings.id, plain: integrationBindings.integrationSecretPlain })
    .from(integrationBindings)
    .where(isNotNull(integrationBindings.integrationSecretPlain));
  if (rows.length === 0) return 0;
  if (!isVaultConfigured()) {
    throw new Error(
      `INTEGRATION_MASTER_KEY is not set but ${rows.length} integration_bindings row(s) hold a plaintext inbound webhook secret. Refusing to boot: set INTEGRATION_MASTER_KEY so core can encrypt them.`,
    );
  }
  for (const row of rows) {
    if (row.plain === null) continue;
    await db
      .update(integrationBindings)
      .set({ integrationSecretEnc: encryptSecret(row.plain), integrationSecretPlain: null })
      .where(
        and(
          eq(integrationBindings.id, row.id),
          isNotNull(integrationBindings.integrationSecretPlain),
        ),
      );
  }
  return rows.length;
}
