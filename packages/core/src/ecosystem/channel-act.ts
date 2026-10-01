import type { Tx } from '../db/client.js';
import { notFound } from './access.js';
import { type DocumentRow, readDocument, type StoredState } from './channel-store.js';
import { type ServedDocument, serveAll } from './channel-world.js';
import type { EcosystemRefusal } from './refusals.js';
import { lockKeys } from './store.js';

export type ChannelOutcome =
  | { ok: true; served: ServedDocument }
  | { ok: false; refusals: EcosystemRefusal[] };

export class Refused extends Error {
  constructor(readonly refusals: EcosystemRefusal[]) {
    super('channel: refused');
  }
}

export const refuse = (code: EcosystemRefusal['code'], path: string, detail: string): never => {
  throw new Refused([{ code, path, detail }]);
};

export async function settle(work: () => Promise<ServedDocument>): Promise<ChannelOutcome> {
  try {
    return { ok: true, served: await work() };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, refusals: err.refusals };
    throw err;
  }
}

export async function served(tx: Tx, id: string): Promise<ServedDocument> {
  const row = await readDocument(tx, id);
  if (!row) throw new Error(`channel: document ${id} vanished inside its own transaction`);
  const [one] = await serveAll(tx, [row]);
  if (!one) throw new Error(`channel: document ${id} served nothing`);
  return one;
}

export async function lockedSender(
  tx: Tx,
  projectId: string,
  documentId: string,
): Promise<DocumentRow> {
  await lockKeys(tx, [`channel-doc:${documentId}`]);
  const row = await readDocument(tx, documentId);
  if (!row || row.fromProjectId !== projectId)
    throw notFound(`no document ${documentId} sent by project ${projectId}`);
  return row;
}

export const notIn = (row: DocumentRow, allowed: readonly StoredState[], act: string): void => {
  if (!allowed.includes(row.state)) {
    refuse(
      'DOCUMENT_STATE_NOT_ALLOWED',
      '/state',
      `${row.number ?? row.id} is ${row.state}; ${act} takes a document that is ${allowed.join(' or ')}.`,
    );
  }
};
