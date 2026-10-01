import { db, type Tx } from '../db/client.js';
import { type ChannelOutcome, lockedSender, notIn, refuse, served, settle } from './channel-act.js';
import type { Writer } from './channel-author.js';
import { type DocumentRow, insertEvent, readNumbered } from './channel-store.js';
import { type ServedDocument, serve, serveAll } from './channel-world.js';

async function standing(tx: Tx, row: DocumentRow, act: string): Promise<ServedDocument> {
  notIn(row, ['published'], act);
  const [current] = await serveAll(tx, [row]);
  if (!current) throw new Error(`channel: ${row.id} served nothing`);
  if (current.document.state !== 'published') {
    refuse(
      'DOCUMENT_STATE_NOT_ALLOWED',
      '/state',
      `${row.number} is already ${current.document.state}; a published document ends once.`,
    );
  }
  return current;
}

export async function withdraw(args: {
  projectId: string;
  documentId: string;
  writer: Writer;
  reason: string;
}): Promise<ChannelOutcome> {
  return settle(() =>
    db.transaction(async (tx) => {
      const row = await lockedSender(tx, args.projectId, args.documentId);
      await standing(tx, row, 'a withdrawal');
      await insertEvent(tx, {
        documentId: row.id,
        verb: 'withdraw',
        fromState: 'published',
        toState: 'withdrawn',
        actor: args.writer.author,
        userId: args.writer.userId,
        reason: args.reason,
      });
      return served(tx, row.id);
    }),
  );
}

export async function supersede(args: {
  projectId: string;
  documentId: string;
  writer: Writer;
  by: string;
  reason: string;
}): Promise<ChannelOutcome> {
  return settle(() =>
    db.transaction(async (tx) => {
      const row = await lockedSender(tx, args.projectId, args.documentId);
      await standing(tx, row, 'a supersession');
      const by = await readNumbered(tx, args.by);
      const replacement = by ? serve(by, []).document : null;
      const why =
        !by || !replacement || by.state !== 'published'
          ? `${args.by} is not a published document`
          : by.id === row.id
            ? 'a document does not replace itself'
            : by.ecosystemId !== row.ecosystemId ||
                by.fromProjectId !== row.fromProjectId ||
                by.type !== row.type
              ? `${args.by} is not a ${row.type} this project sent in the same channel`
              : (by.publishedAt?.getTime() ?? 0) < (row.publishedAt?.getTime() ?? 0)
                ? `${args.by} was published before ${row.number}`
                : null;
      if (why) {
        refuse(
          'SUPERSEDE_NOT_A_REPLACEMENT',
          '/by',
          `${why}; publish the replacement first, then supersede ${row.number} with its number.`,
        );
      }
      const [byServed] = by ? await serveAll(tx, [by]) : [];
      if (byServed?.document.state !== 'published') {
        refuse(
          'SUPERSEDE_NOT_A_REPLACEMENT',
          '/by',
          `${args.by} has itself ended; a replacement is a document that stands.`,
        );
      }
      await insertEvent(tx, {
        documentId: row.id,
        verb: 'supersede',
        fromState: 'published',
        toState: 'superseded',
        actor: args.writer.author,
        userId: args.writer.userId,
        reason: args.reason,
        supersededBy: args.by,
      });
      return served(tx, row.id);
    }),
  );
}
