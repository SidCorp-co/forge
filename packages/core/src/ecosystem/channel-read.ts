import { db } from '../db/client.js';
import { notFound } from './access.js';
import { owesReply, type RegisterRow, registerRowsOver } from './channel-register.js';
import { heldThreads, today } from './channel-rules.js';
import { NUMBER_PATTERN, type ThreadHold, UUID_PATTERN } from './channel-schema.js';
import {
  type DocumentRow,
  documentsWhere,
  holdsOn,
  readDocument,
  readNumbered,
  repliesFrom,
} from './channel-store.js';
import { holdOf, type ServedDocument, serveAll } from './channel-world.js';

export interface PartyView extends ServedDocument {
  side: 'sender' | 'recipient';
  thread: string | null;
  hold: ThreadHold | null;
}

// the narrow party read: a recipient sees a document only once it is published, the sender sees its own in every state, and nobody sees another pair's
const sideOf = (row: DocumentRow, projectId: string): PartyView['side'] | null => {
  if (row.fromProjectId === projectId) return 'sender';
  if (row.state === 'published' && row.toProjectIds.includes(projectId)) return 'recipient';
  return null;
};

async function viewsOf(projectId: string, rows: readonly DocumentRow[]): Promise<PartyView[]> {
  const mine = rows.flatMap((r) => {
    const side = sideOf(r, projectId);
    return side ? [{ row: r, side }] : [];
  });
  const served = await serveAll(
    db,
    mine.map((m) => m.row),
  );
  const threads = [...new Set(mine.flatMap((m) => (m.row.thread ? [m.row.thread] : [])))];
  const held = heldThreads((await holdsOn(db, threads)).map(holdOf));
  return mine.map((m, i) => {
    const s = served[i];
    if (!s) throw new Error(`channel: ${m.row.id} served nothing`);
    return {
      ...s,
      side: m.side,
      thread: m.row.thread,
      hold: (m.row.thread && held.get(m.row.thread)) || null,
    };
  });
}

export async function readAs(projectId: string, ref: string): Promise<PartyView> {
  const row = UUID_PATTERN.test(ref)
    ? await readDocument(db, ref)
    : NUMBER_PATTERN.test(ref)
      ? await readNumbered(db, ref)
      : null;
  const [view] = row ? await viewsOf(projectId, [row]) : [];
  if (!view) throw notFound(`no document ${ref} that project ${projectId} is a party to`);
  return view;
}

export async function outbox(projectId: string): Promise<PartyView[]> {
  return viewsOf(projectId, await documentsWhere(db, { from: projectId }));
}

export interface InboxEntry extends PartyView {
  owesReply: boolean;
  answered: boolean;
  overdue: boolean;
}

// answered and overdue are derived on every read and never stored, so a lapsed due date reads as overdue rather than closing itself
export async function inbox(projectId: string): Promise<InboxEntry[]> {
  const views = (
    await viewsOf(projectId, await documentsWhere(db, { to: projectId, published: true }))
  ).filter((v) => v.document.state === 'published');
  const numbers = views.flatMap((v) => (v.document.number ? [v.document.number] : []));
  const answered = await repliesFrom(db, projectId, numbers);
  return views.map((v) => {
    const d = v.document;
    const owed = owesReply(d);
    const done = d.number ? answered.has(d.number) : false;
    return {
      ...v,
      owesReply: owed,
      answered: done,
      overdue: owed && !done && d.dueBy !== undefined && d.dueBy < today(),
    };
  });
}

// unanswered is the work a side's master owes: published to it, owing a reply, not yet answered by a published one, on no thread a person holds, and with no reply of its own already waiting at the approve gate, where the next act is a person's
export async function unanswered(projectId: string): Promise<InboxEntry[]> {
  const owed = (await inbox(projectId)).filter((e) => e.owesReply && !e.answered && !e.hold);
  if (owed.length === 0) return [];
  const atGate = new Set(
    (await documentsWhere(db, { from: projectId }))
      .filter((r) => r.state === 'submitted' && r.inReplyTo)
      .map((r) => r.inReplyTo),
  );
  return owed.filter((e) => !atGate.has(e.document.number ?? null));
}

export async function threadAs(
  projectId: string,
  number: string,
): Promise<{ thread: string; documents: PartyView[]; holds: ThreadHold[] }> {
  const root = await readNumbered(db, number);
  if (!root || !sideOf(root, projectId)) {
    throw notFound(`no conversation ${number} that project ${projectId} is a party to`);
  }
  const documents = await viewsOf(projectId, await documentsWhere(db, { thread: number }));
  return { thread: number, documents, holds: (await holdsOn(db, [number])).map(holdOf) };
}

// a document's standing is the register's own row for it, derived by `rowsOf` over its conversation, so the document page and the register can never disagree about overdue
export async function standingOf(view: PartyView): Promise<RegisterRow | null> {
  const number = view.document.number;
  if (!number || !view.thread) return null;
  const rows = await registerRowsOver(await documentsWhere(db, { thread: view.thread }));
  return rows.find((r) => r.number === number) ?? null;
}
