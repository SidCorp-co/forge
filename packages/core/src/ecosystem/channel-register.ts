import { db } from '../db/client.js';
import { readerProjects } from './access.js';
import { heldThreads, REPLIES, today } from './channel-rules.js';
import type { ChannelDocument, ThreadHold } from './channel-schema.js';
import { type DocumentRow, documentsWhere, holdsOn } from './channel-store.js';
import { holdOf, serveAll } from './channel-world.js';
import { readableEcosystem } from './membership-service.js';
import type { DocumentType } from './schema.js';

export const REGISTER_STATUSES = ['open', 'overdue', 'held', 'answered', 'closed'] as const;
export type RegisterStatus = (typeof REGISTER_STATUSES)[number];

export type RecipientStatus = 'awaiting' | 'answered' | 'overdue' | 'not-owed';

export interface RegisterRow {
  number: string;
  type: DocumentType;
  subject: string;
  from: string;
  to: string[];
  inReplyTo: string | null;
  thread: string | null;
  state: ChannelDocument['state'];
  authoredBy: ChannelDocument['authoredBy'];
  publishedAt: string | null;
  dueBy: string | null;
  recipients: { project: string; status: RecipientStatus; answeredBy: string | null }[];
  open: boolean;
  overdue: boolean;
  owner: string[];
  hold: ThreadHold | null;
}

export interface RegisterQuery {
  status?: RegisterStatus | undefined;
  type?: DocumentType | undefined;
  party?: string | undefined;
  limit: number;
  /** The projects a credential fenced to some of the reader's projects reads as; the rest of theirs stay out. */
  fence?: readonly string[] | undefined;
}

export type Listed = ChannelDocument & { thread: string | null };

export const owesReply = (d: ChannelDocument) =>
  REPLIES[d.type].length > 0 && !(d.type === 'change-notice' && d.body.binding === false);

// cm:why awaiting, answered, overdue and the owner are derived on every read from the published documents and never stored, so a lapsed date reads overdue and nothing closes itself
export function rowsOf(
  docs: readonly Listed[],
  held: ReadonlyMap<string, ThreadHold>,
  today: string,
): RegisterRow[] {
  const replies = new Map<string, Map<string, string>>();
  for (const d of docs) {
    if (!d.inReplyTo || !d.number || d.state === 'withdrawn') continue;
    const byFrom = replies.get(d.inReplyTo) ?? new Map<string, string>();
    if (!byFrom.has(d.from) || d.state === 'published') byFrom.set(d.from, d.number);
    replies.set(d.inReplyTo, byFrom);
  }
  return docs.flatMap((d) => {
    if (!d.number) return [];
    const standing = d.state === 'published';
    const owed = standing && owesReply(d);
    const recipients = d.to.map((project) => {
      const answeredBy = replies.get(d.number ?? '')?.get(project) ?? null;
      const status: RecipientStatus = !owed
        ? 'not-owed'
        : answeredBy
          ? 'answered'
          : d.dueBy !== undefined && d.dueBy < today
            ? 'overdue'
            : 'awaiting';
      return { project, status, answeredBy };
    });
    const owner = recipients
      .filter((r) => r.status === 'awaiting' || r.status === 'overdue')
      .map((r) => r.project);
    return [
      {
        number: d.number,
        type: d.type,
        subject: d.subject,
        from: d.from,
        to: d.to,
        inReplyTo: d.inReplyTo ?? null,
        thread: d.thread ?? null,
        state: d.state,
        authoredBy: d.authoredBy,
        publishedAt: d.publishedAt ?? null,
        dueBy: d.dueBy ?? null,
        recipients,
        open: owner.length > 0,
        overdue: recipients.some((r) => r.status === 'overdue'),
        owner,
        hold: held.get(d.thread ?? d.number) ?? null,
      },
    ];
  });
}

export async function registerRowsOver(stored: readonly DocumentRow[]): Promise<RegisterRow[]> {
  const served = await serveAll(db, stored);
  const threadOf = new Map(stored.map((r) => [r.id, r.thread]));
  const docs = served.map((s) => ({ ...s.document, thread: threadOf.get(s.id) ?? null }));
  const threads = [...new Set(docs.flatMap((d) => (d.thread ? [d.thread] : [])))];
  const held = heldThreads((await holdsOn(db, threads)).map(holdOf));
  return rowsOf(docs, held, today());
}

const matches = (row: RegisterRow, status: RegisterStatus | undefined) => {
  if (!status) return true;
  if (status === 'open') return row.open;
  if (status === 'overdue') return row.overdue;
  if (status === 'held') return row.hold !== null;
  if (status === 'answered') return row.recipients.some((r) => r.status === 'answered');
  return row.state !== 'published';
};

// cm:why the register lists only documents one of the reader's projects sent or received; the steward org and visibility "all" see no other pair's documents
export async function readRegister(
  userId: string,
  ecosystemId: string,
  query: RegisterQuery,
): Promise<{ rows: RegisterRow[]; total: number }> {
  await readableEcosystem(userId, ecosystemId);
  const visible = await readerProjects(userId);
  const mine = query.fence ? new Set(query.fence.filter((p) => visible.has(p))) : visible;
  const stored = await documentsWhere(db, { ecosystem: ecosystemId, published: true });
  const listed = (await registerRowsOver(stored))
    .filter((r) => mine.has(r.from) || r.to.some((t) => mine.has(t)))
    .filter((r) => !query.party || r.from === query.party || r.to.includes(query.party))
    .filter((r) => !query.type || r.type === query.type)
    .filter((r) => matches(r, query.status))
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  return { rows: listed.slice(0, query.limit), total: listed.length };
}
