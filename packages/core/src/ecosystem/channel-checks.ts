import type { Tx } from '../db/client.js';
import { Refused } from './channel-act.js';
import { documentRefusals, parseChannelDocument, threadRoot } from './channel-rules.js';
import type { ChannelDocument } from './channel-schema.js';
import { loadWorld, publishedChain } from './channel-world.js';
import { lockKeys } from './store.js';

export function parsedOrRefused(raw: unknown): ChannelDocument {
  const parsed = parseChannelDocument(raw);
  if (!parsed.ok) throw new Refused(parsed.refusals);
  return parsed.value;
}

export async function checked(
  tx: Tx,
  doc: ChannelDocument,
): Promise<{ doc: ChannelDocument; thread: string | null }> {
  const documents = await publishedChain(tx, doc.ecosystem, doc.inReplyTo);
  const root = threadRoot(doc, documents);
  if (root && root !== doc.number) await lockKeys(tx, [`channel-thread:${root}`]);
  const world = await loadWorld(tx, {
    ecosystemId: doc.ecosystem,
    from: doc.from,
    documents,
    threads: root ? [root] : [],
    cites: doc,
  });
  const refusals = documentRefusals(doc, world);
  if (refusals.length > 0) throw new Refused(refusals);
  return { doc, thread: root ?? doc.number ?? null };
}
