// An integration connection's credential set through its edit page (ISS-1348): the threads that asked
// for it hear that it was filled, by fingerprint. The adapter builds the fact and emits none, so the
// door that wrote the value emits it here.

import { db } from '../db/client.js';
import { connectionCredentialFilled } from '../integrations/index.js';
import { emitEvent } from '../outbox/index.js';

/** Tells the asking threads that `by` set the connection's credential with `secrets`, where they did. */
export async function tellCredentialFilled(
  connection: { id: string; provider: string },
  secrets: Record<string, unknown>,
  by: string,
): Promise<void> {
  const filled = connectionCredentialFilled(connection, secrets, 'page', by);
  if (filled) await emitEvent(db, 'secret.slotFilled', filled);
}
