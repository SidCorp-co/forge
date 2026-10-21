// The outbox event a proposal leaves (REQ-48 BC-3): a suggestion proposed or revised is a handoff the
// steward checks, so it is announced in the transaction that writes it.

import type { StewardEventPayloads } from '@forge/contracts/steward';
import type { Tx } from '../db/client.js';
import { emitEvent } from '../outbox/index.js';

export async function emitSuggestionProposed(
  tx: Tx,
  payload: StewardEventPayloads['suggestion.proposed'],
): Promise<void> {
  await emitEvent(tx, 'suggestion.proposed', payload);
}
