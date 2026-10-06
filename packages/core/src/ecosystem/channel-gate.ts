import type { Tx } from '../db/client.js';
import { emitEvent } from '../outbox/index.js';
import { notIn, refuse } from './channel-act.js';
import { checked, parsedOrRefused } from './channel-checks.js';
import type { Author, Gate, PersonVia } from './channel-schema.js';
import { emitPublished } from './channel-signals.js';
import { insertEvent, readDocument, rewriteDocument } from './channel-store.js';
import { serve } from './channel-world.js';
import { lockKeys } from './store.js';

export const GATE_OPTIONS = { approve: 'approve', return: 'return' } as const;

type GateArgs = {
  documentId: string;
  projectId: string;
  optionId: string;
  note: string | undefined;
  by: string;
  via: PersonVia;
};

function decisionOf(args: GateArgs): 'approved' | 'returned' {
  const decision =
    args.optionId === GATE_OPTIONS.approve
      ? 'approved'
      : args.optionId === GATE_OPTIONS.return
        ? 'returned'
        : null;
  if (!decision) {
    throw new Error(
      `channel: gate question carries option ${args.optionId}, which decides nothing`,
    );
  }
  if (decision === 'returned' && !args.note) {
    refuse(
      'GATE_RETURN_WITHOUT_NOTE',
      '/gate/note',
      'a returned document says what to change: answer the gate question with { "optionId": "return", "note": … }.',
    );
  }
  return decision;
}

async function recordDecided(
  tx: Tx,
  documentId: string,
  published: boolean,
  args: GateArgs,
  now: Date,
) {
  const actor: Author = { kind: 'person', id: args.by, via: args.via };
  const at = { actor, userId: args.by, at: now };
  await insertEvent(tx, {
    documentId,
    verb: published ? 'approve' : 'return',
    fromState: 'submitted',
    toState: published ? 'published' : 'returned',
    reason: args.note ?? null,
    ...at,
  });
  if (published) {
    await insertEvent(tx, {
      documentId,
      verb: 'publish',
      fromState: 'submitted',
      toState: 'published',
      ...at,
    });
  }
}

// the gate is decided only by answering its question, inside the answer's transaction, so an approval that the checks refuse leaves the question open and nothing published
export async function decideChannelGate(tx: Tx, args: GateArgs): Promise<void> {
  await lockKeys(tx, [`channel-doc:${args.documentId}`]);
  const row = await readDocument(tx, args.documentId);
  if (!row || row.fromProjectId !== args.projectId) {
    throw new Error(
      `channel: gate question names document ${args.documentId}, which project ${args.projectId} did not send`,
    );
  }
  notIn(row, ['submitted'], 'a gate decision');
  const decision = decisionOf(args);
  const now = new Date();
  const gate: Gate = {
    mode: 'approve',
    decision,
    decidedBy: args.by,
    decidedAt: now.toISOString(),
    ...(args.note ? { note: args.note } : {}),
  };
  const stored = serve(row, []).document;
  const state = decision === 'approved' ? 'published' : 'returned';
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
  await recordDecided(tx, row.id, state === 'published', args, now);
  await emitEvent(tx, 'channel.gateDecided', {
    projectId: doc.from,
    documentId: row.id,
    number: doc.number ?? null,
    subject: doc.subject,
    published: state === 'published',
    decidedBy: args.by,
    note: args.note ?? null,
  });
  if (state === 'published') await emitPublished(tx, row.id, doc);
}
