import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/client.js';
import { listProjectHeads } from '../projects/index.js';
import { insertAskedQuestion } from '../questions/index.js';
import { GATE_OPTIONS } from './channel-gate.js';
import type { ChannelDocument } from './channel-schema.js';

// cm:why the approve gate is a question on the sending project with no issue and no session, so it parks no run and holds no lease while it waits
export async function askGate(tx: Tx, documentId: string, d: ChannelDocument): Promise<string> {
  if (!d.number) throw new Error(`channel: ${documentId} reached the gate without a number`);
  const slug = new Map((await listProjectHeads(d.to)).map((r) => [r.id, r.slug]));
  const to = d.to.map((p) => slug.get(p) ?? p).join(', ');
  const fingerprint = `channel-gate:${documentId}`;
  const option = {
    authority: 'admin',
    bindsTo: 'this_call',
    executedBy: 'core',
    fingerprint,
  } as const;
  const id = randomUUID();
  await insertAskedQuestion(tx, {
    id,
    projectId: d.from,
    prompt: `Publish ${d.number}, a ${d.type} to ${to}? It reaches the other side only once an admin of this project approves it.`,
    blockerKind: 'human',
    origin: { kind: 'channel_gate', documentId, number: d.number },
    answer: {
      shape: 'choice',
      recommendedOptionId: GATE_OPTIONS.approve,
      options: [
        { id: GATE_OPTIONS.approve, label: 'Approve and publish it', ...option },
        {
          id: GATE_OPTIONS.return,
          label: 'Return it to the writer, with a note saying what to change',
          ...option,
        },
      ],
    },
  });
  return id;
}
