import type { Tx } from '../db/client.js';
import { notIn, refuse } from './channel-act.js';
import { checked, parsedOrRefused } from './channel-checks.js';
import type { Author, Gate, PersonVia } from './channel-schema.js';
import { announceGateDecided } from './channel-signals.js';
import { insertEvent, readDocument, rewriteDocument } from './channel-store.js';
import { serve } from './channel-world.js';
import { landChangeRequestIn } from './requests/land.js';
import { lockKeys } from './store.js';

export const GATE_OPTIONS = { approve: 'approve', return: 'return' } as const;

// cm:why the gate is decided only by answering its question, inside the answer's transaction, so an approval that the checks refuse leaves the question open and nothing published
export async function decideChannelGate(
  tx: Tx,
  args: {
    documentId: string;
    projectId: string;
    optionId: string;
    note: string | undefined;
    by: string;
    via: PersonVia;
  },
): Promise<() => Promise<void>> {
  await lockKeys(tx, [`channel-doc:${args.documentId}`]);
  const row = await readDocument(tx, args.documentId);
  if (!row || row.fromProjectId !== args.projectId) {
    throw new Error(
      `channel: gate question names document ${args.documentId}, which project ${args.projectId} did not send`,
    );
  }
  notIn(row, ['submitted'], 'a gate decision');
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
  const actor: Author = { kind: 'person', id: args.by, via: args.via };
  const at = { actor, userId: args.by, at: now };
  await insertEvent(tx, {
    documentId: row.id,
    verb: state === 'published' ? 'approve' : 'return',
    fromState: 'submitted',
    toState: state,
    reason: args.note ?? null,
    ...at,
  });
  if (state === 'published') {
    await insertEvent(tx, {
      documentId: row.id,
      verb: 'publish',
      fromState: 'submitted',
      toState: 'published',
      ...at,
    });
    await landChangeRequestIn(tx, doc, {
      documentId: row.id,
      by: { userId: args.by, agency: 'human' },
    });
  }
  return () => announceGateDecided(row.id, doc);
}
