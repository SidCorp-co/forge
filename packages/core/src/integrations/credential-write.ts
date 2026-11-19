// An integration connection's credential given a value (ISS-1348): through its edit page's
// replace-key box (the connection PATCH) or through a one-time write URL a room agent asked for. Either
// way the threads that asked for it hear that it was filled, by a keyed fingerprint of the value under
// the connection's id, never the value: this adapter builds the `secret.slotFilled` fact, and the door
// or domain that wrote the value emits it, as an adapter emits no event of its own.

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { RefusalError } from '../lib/refusal.js';
import { applySecretsPatch } from './provider-schemas.js';
import { getAdapter, getIntegration } from './registry.js';
import { notifyConnectionChanged } from './route-helpers.js';
import { findConnectionById, updateConnection } from './store.js';
import { fingerprintSecret } from './vault.js';

/** The slot a connection's credential is, as a room's secret asks name it. */
export const connectionSlotKey = (connectionId: string) => `connection:${connectionId}`;

/** The field a person types a provider's credential into; null where none is typed by hand. */
export function credentialFieldOf(provider: string): string | null {
  return getIntegration(provider)?.schemas.primaryCredentialField ?? null;
}

/** The fact the asking threads hear when `secrets` set the connection's credential; null where they did not. */
export function connectionCredentialFilled(
  connection: { id: string; provider: string },
  secrets: Record<string, unknown>,
  via: 'page' | 'presigned',
): OutboxEventPayload<'secret.slotFilled'> | null {
  const field = credentialFieldOf(connection.provider);
  const value = field ? secrets[field] : undefined;
  if (typeof value !== 'string' || value === '') return null;
  return {
    projectId: null,
    slot: connectionSlotKey(connection.id),
    fingerprint: fingerprintSecret(connection.id, value),
    via,
    at: new Date().toISOString(),
  };
}

/**
 * The connection's credential replaced by `value`, judged as its edit page's replace-key box is: the
 * provider's own field, its rotation, and its fitness check. Refused by name where the provider takes
 * no credential typed by hand or the connection is gone; nothing is written then. Answers the fact the
 * caller emits.
 */
export async function writeConnectionCredential(
  connectionId: string,
  value: string,
): Promise<OutboxEventPayload<'secret.slotFilled'>> {
  const connection = await findConnectionById(connectionId);
  const field = connection ? credentialFieldOf(connection.provider) : null;
  if (!connection || !field) {
    throw new RefusalError(
      [
        {
          code: 'SUPPORT_SECRET_INTEGRATION_NOT_BY_HAND',
          path: '',
          detail: connection
            ? `a ${connection.provider} connection takes no credential typed by hand; nothing was written.`
            : `connection ${connectionId} is gone; nothing was written.`,
        },
      ],
      'SUPPORT_REFUSED',
    );
  }
  const secrets = await applySecretsPatch({
    provider: connection.provider,
    rawSecrets: { [field]: value },
    secretsEnc: connection.secretsEnc,
    vaultGuardTiming: 'before-parse',
  });
  if (!secrets) throw new Error(`integrations: ${connection.provider} took no ${field}`);
  const unfit = getAdapter(connection.provider)?.verifyConnection?.({
    config: (connection.config ?? {}) as Record<string, unknown>,
    secrets,
  });
  if (unfit?.length) throw new RefusalError(unfit, 'CONFIG_REFUSED');
  await updateConnection(connection.id, { secrets });
  notifyConnectionChanged(connection.provider, connection.id);
  const filled = connectionCredentialFilled(connection, { [field]: value }, 'presigned');
  if (!filled) throw new Error(`integrations: ${connection.provider} took an empty ${field}`);
  return filled;
}
