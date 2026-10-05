/**
 * A provider that generates the inbound signing secret itself — GitHub's App webhook secret — holds
 * it in the connection's encrypted secrets under the field it declares (`inboundSecretField`), and
 * every binding of the connection carries a copy. A rotation keeps the replaced secret under
 * `previous<Field>`, so deliveries signed with either verify until the first one verifies with the
 * new secret, which drops the old.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationConnections } from '../db/schema.js';
import { getAdapter } from './registry.js';
import { type IntegrationConnectionRow, writeConnectionSecrets } from './store.js';
import { decryptJson, encryptJson } from './vault.js';

const previousOf = (field: string) => `previous${field.charAt(0).toUpperCase()}${field.slice(1)}`;
const fieldOf = (connection: IntegrationConnectionRow) =>
  getAdapter(connection.provider)?.inboundSecretField ?? null;

function heldValue(connection: IntegrationConnectionRow, key: (field: string) => string) {
  const field = fieldOf(connection);
  if (!field || !connection.secretsEnc) return null;
  const value = decryptJson<Record<string, unknown>>(connection.secretsEnc)[key(field)];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The secret the provider signs with, where the provider holds it; null where Forge mints one. */
export const heldInboundSecret = (connection: IntegrationConnectionRow) =>
  heldValue(connection, (field) => field);

/** The held secret a rotation replaced, still verifying until a delivery verifies with the new one. */
export const previousHeldInboundSecret = (connection: IntegrationConnectionRow) =>
  heldValue(connection, previousOf);

export const mintInboundSecret = () => `whsec_${randomBytes(24).toString('hex')}`;

/** Replace a held secret, keeping the old one beside it. Null where the provider holds none. */
export async function rotateHeldInboundSecret(connectionId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [connection] = await tx
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .for('update');
    const field = connection ? fieldOf(connection) : null;
    if (!connection?.secretsEnc || !field) return null;
    const secrets = decryptJson<Record<string, unknown>>(connection.secretsEnc);
    const secret = mintInboundSecret();
    const next = { ...secrets, [field]: secret, [previousOf(field)]: secrets[field] };
    await writeConnectionSecrets(tx, connectionId, encryptJson(next), new Date());
    return secret;
  });
}

/** A delivery verified with the new secret: the replaced one stops verifying. */
export async function dropPreviousHeldInboundSecret(connectionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [connection] = await tx
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .for('update');
    const field = connection ? fieldOf(connection) : null;
    if (!connection?.secretsEnc || !field) return;
    const { [previousOf(field)]: _dropped, ...kept } = decryptJson<Record<string, unknown>>(
      connection.secretsEnc,
    );
    await writeConnectionSecrets(tx, connectionId, encryptJson(kept), new Date());
  });
}
