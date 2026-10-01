import { randomUUID } from 'node:crypto';
import { db, type Tx } from '../db/client.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import { isRecord } from '../project-config/documents.js';
import {
  type ChannelOutcome,
  lockedSender,
  notIn,
  Refused,
  refuse,
  served,
  settle,
} from './channel-act.js';
import type { Writer } from './channel-author.js';
import { documentRefusals, parseChannelDocument, threadRoot } from './channel-rules.js';
import {
  type ChannelDocument,
  DOCUMENT_SCHEMA_ID,
  type Gate,
  TYPE_CODES,
} from './channel-schema.js';
import { insertDraft, insertEvent, reserveNumber, rewriteDocument } from './channel-store.js';
import { loadWorld, publishedChain, serve } from './channel-world.js';
import { heldEcosystem } from './ecosystem-service.js';
import { type EcosystemDocument, interfaceDocumentSchema } from './schema.js';
import { lockKeys, readEcosystem, readInterfaces } from './store.js';

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export interface DraftInput {
  type: unknown;
  to: unknown;
  subject: unknown;
  dueBy?: unknown;
  inReplyTo?: unknown;
  body: unknown;
}

async function defaultDue(
  tx: Tx,
  eco: EcosystemDocument,
  input: DraftInput,
): Promise<string | undefined> {
  if (input.dueBy !== undefined) return undefined;
  if (input.type === 'change-notice') {
    if (isRecord(input.body) && input.body.binding === false) return undefined;
    return addDays(today(), eco.channel.responseDays['change-notice']);
  }
  if (input.type !== 'rfi' && input.type !== 'change-request') return undefined;
  const kind = input.type;
  const to = Array.isArray(input.to)
    ? input.to.filter((t): t is string => typeof t === 'string')
    : [];
  const promised = [...(await readInterfaces(tx, to)).values()].flatMap((row) => {
    const parsed = interfaceDocumentSchema.safeParse(row.document);
    return parsed.success ? [parsed.data.commitments.responseDays[kind]] : [];
  });
  const days =
    promised.length === to.length && to.length > 0
      ? Math.max(...promised)
      : eco.channel.responseDays[kind];
  return addDays(today(), days);
}

function compose(
  base: { id: string; ecosystem: string; from: string; number: string | null; gate?: Gate },
  input: DraftInput,
  author: Writer['author'],
  dueBy: string | undefined,
): unknown {
  return {
    $schema: DOCUMENT_SCHEMA_ID,
    version: 1,
    id: base.id,
    ecosystem: base.ecosystem,
    type: input.type,
    from: base.from,
    to: input.to,
    subject: input.subject,
    state: 'draft',
    authoredBy: author,
    number: base.number,
    inReplyTo: input.inReplyTo ?? null,
    ...(input.dueBy !== undefined ? { dueBy: input.dueBy } : dueBy ? { dueBy } : {}),
    ...(base.gate ? { gate: base.gate } : {}),
    body: input.body,
  };
}

function parsedOrRefused(raw: unknown): ChannelDocument {
  const parsed = parseChannelDocument(raw);
  if (!parsed.ok) throw new Refused(parsed.refusals);
  return parsed.value;
}

async function ecosystemOr(tx: Tx, id: string): Promise<EcosystemDocument> {
  const row = await readEcosystem(tx, id);
  if (!row)
    return refuse(
      'REF_UNRESOLVED',
      '/ecosystem',
      `no ecosystem ${id}; a draft is written into the channel of an ecosystem that exists.`,
    );
  return heldEcosystem(row).document;
}

export async function createDraft(args: {
  projectId: string;
  writer: Writer;
  ecosystemId: string;
  input: DraftInput;
}): Promise<ChannelOutcome> {
  return settle(() =>
    db.transaction(async (tx) => {
      const eco = await ecosystemOr(tx, args.ecosystemId);
      const id = randomUUID();
      const doc = parsedOrRefused(
        compose(
          { id, ecosystem: args.ecosystemId, from: args.projectId, number: null },
          args.input,
          args.writer.author,
          await defaultDue(tx, eco, args.input),
        ),
      );
      await insertDraft(tx, {
        id,
        ecosystemId: args.ecosystemId,
        type: doc.type,
        fromProjectId: args.projectId,
        toProjectIds: doc.to,
        inReplyTo: doc.inReplyTo ?? null,
        author: args.writer.author,
        document: doc,
        userId: args.writer.userId,
      });
      await insertEvent(tx, {
        documentId: id,
        verb: 'draft',
        fromState: null,
        toState: 'draft',
        actor: args.writer.author,
        userId: args.writer.userId,
      });
      return served(tx, id);
    }),
  );
}

export async function editDraft(args: {
  projectId: string;
  documentId: string;
  writer: Writer;
  input: DraftInput;
}): Promise<ChannelOutcome> {
  return settle(() =>
    db.transaction(async (tx) => {
      const row = await lockedSender(tx, args.projectId, args.documentId);
      notIn(row, ['draft', 'returned'], 'an edit');
      if (args.input.type !== row.type) {
        refuse(
          'DOCUMENT_TYPE_IMMUTABLE',
          '/type',
          `this draft is a ${row.type}; a type is fixed at draft, so write a new draft for a ${String(args.input.type)}.`,
        );
      }
      const eco = await ecosystemOr(tx, row.ecosystemId);
      const before = serve(row, []).document;
      const doc = parsedOrRefused(
        compose(
          {
            id: row.id,
            ecosystem: row.ecosystemId,
            from: row.fromProjectId,
            number: row.number,
            ...(before.gate ? { gate: before.gate } : {}),
          },
          args.input,
          args.writer.author,
          await defaultDue(tx, eco, args.input),
        ),
      );
      await rewriteDocument(tx, row.id, {
        state: 'draft',
        number: row.number,
        thread: null,
        toProjectIds: doc.to,
        inReplyTo: doc.inReplyTo ?? null,
        author: args.writer.author,
        document: doc,
        publishedAt: null,
      });
      await insertEvent(tx, {
        documentId: row.id,
        verb: 'edit',
        fromState: row.state,
        toState: 'draft',
        actor: args.writer.author,
        userId: args.writer.userId,
      });
      return served(tx, row.id);
    }),
  );
}

async function checked(
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
  });
  const refusals = documentRefusals(doc, world);
  if (refusals.length > 0) throw new Refused(refusals);
  return { doc, thread: root ?? doc.number ?? null };
}

export async function submit(args: {
  projectId: string;
  documentId: string;
  writer: Writer;
}): Promise<ChannelOutcome> {
  return settle(() =>
    db.transaction(async (tx) => {
      const row = await lockedSender(tx, args.projectId, args.documentId);
      notIn(row, ['draft'], 'submit');
      const eco = await ecosystemOr(tx, row.ecosystemId);
      const stored = serve(row, []).document;
      const mode = eco.gate[row.type];
      const number =
        row.number ??
        `${eco.channel.code}-${TYPE_CODES[row.type]}-${await reserveNumber(tx, row.ecosystemId, row.type)}`;
      const now = new Date();
      const state = mode === 'publish' ? 'published' : 'submitted';
      const { gate: _was, ...rest } = stored;
      const next = parsedOrRefused({
        ...rest,
        number,
        state,
        authoredBy: args.writer.author,
        gate: { mode },
        ...(state === 'published' ? { publishedAt: now.toISOString() } : {}),
      });
      const { doc, thread } = await checked(tx, next);
      await rewriteDocument(tx, row.id, {
        state,
        number,
        thread,
        toProjectIds: doc.to,
        inReplyTo: doc.inReplyTo ?? null,
        author: args.writer.author,
        document: doc,
        publishedAt: state === 'published' ? now : null,
      });
      const actor = { actor: args.writer.author, userId: args.writer.userId, at: now };
      await insertEvent(tx, {
        documentId: row.id,
        verb: 'submit',
        fromState: 'draft',
        toState: state,
        ...actor,
      });
      if (state === 'published') {
        await insertEvent(tx, {
          documentId: row.id,
          verb: 'publish',
          fromState: 'draft',
          toState: 'published',
          ...actor,
        });
      }
      return served(tx, row.id);
    }),
  );
}

export async function decideGate(args: {
  projectId: string;
  documentId: string;
  writer: Writer;
  decision: 'approved' | 'returned';
  note: string | undefined;
}): Promise<ChannelOutcome> {
  return settle(() =>
    db.transaction(async (tx) => {
      const row = await lockedSender(tx, args.projectId, args.documentId);
      const { author, userId } = args.writer;
      if (author.kind !== 'person') {
        refuse(
          'GATE_NOT_AUTHORISED',
          '/gate/decidedBy',
          'an agent never approves or returns a document; a person who is admin of the sending project does.',
        );
      }
      const access = await effectiveProjectRole(userId, args.projectId);
      if (!projectRoleAtLeast(access?.role ?? null, 'admin')) {
        refuse(
          'GATE_NOT_AUTHORISED',
          '/gate/decidedBy',
          `${userId} is not an admin of the sending project, and only its admin decides the gate.`,
        );
      }
      notIn(row, ['submitted'], 'a gate decision');
      if (args.decision === 'returned' && !args.note) {
        refuse(
          'GATE_RETURN_WITHOUT_NOTE',
          '/gate/note',
          'a returned document says what to change: send { "decision": "returned", "note": … }.',
        );
      }
      const now = new Date();
      const gate: Gate = {
        mode: 'approve',
        decision: args.decision,
        decidedBy: userId,
        decidedAt: now.toISOString(),
        ...(args.note ? { note: args.note } : {}),
      };
      const stored = serve(row, []).document;
      const state = args.decision === 'approved' ? 'published' : 'returned';
      const next = parsedOrRefused({
        ...stored,
        state,
        gate,
        ...(state === 'published' ? { publishedAt: now.toISOString() } : {}),
      });
      const passed = state === 'published' ? await checked(tx, next) : { doc: next, thread: null };
      const doc = passed.doc;
      await rewriteDocument(tx, row.id, {
        state,
        number: row.number,
        thread: passed.thread,
        toProjectIds: doc.to,
        inReplyTo: doc.inReplyTo ?? null,
        author: stored.authoredBy,
        document: doc,
        publishedAt: state === 'published' ? now : null,
      });
      const actor = { actor: author, userId, at: now };
      await insertEvent(tx, {
        documentId: row.id,
        verb: state === 'published' ? 'approve' : 'return',
        fromState: 'submitted',
        toState: state,
        reason: args.note ?? null,
        ...actor,
      });
      if (state === 'published') {
        await insertEvent(tx, {
          documentId: row.id,
          verb: 'publish',
          fromState: 'submitted',
          toState: 'published',
          ...actor,
        });
      }
      return served(tx, row.id);
    }),
  );
}
