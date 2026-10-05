import type { Tx } from '../db/client.js';
import { emitEvent } from '../outbox/index.js';
import type { ChannelDocument } from './channel-schema.js';

// cm:why a document is published at submit or by its gate's approval, and both acts tell the bell and the receiving masters through this one event, in their own transaction
export async function emitPublished(tx: Tx, documentId: string, d: ChannelDocument): Promise<void> {
  await emitEvent(tx, 'channel.documentPublished', {
    projectId: d.from,
    documentId,
    number: d.number ?? null,
    subject: d.subject,
    type: d.type,
    to: d.to,
    authorPersonId: d.authoredBy.kind === 'person' ? d.authoredBy.id : null,
  });
}
