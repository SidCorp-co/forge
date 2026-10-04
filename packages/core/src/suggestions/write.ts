/**
 * What every suggestion write shares: one transaction whose refusals roll it back, the lock on the
 * target, the decision record on an issue, and the answer read back after the commit.
 */

import type { SuggestionView } from '@forge/contracts/suggestions';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { suggestions } from '../db/schema-suggestions.js';
import { lockFeedback } from '../feedback/service.js';
import { writeRecordEvent } from '../issues/record-events/store.js';
import { type Refusal, RefusalError } from '../lib/refusal.js';
import { lockRequirements } from '../requirements/service.js';
import type { Effect } from './effects.js';
import { type Row, type SuggestionActor, type SuggestionTarget, viewOf } from './read.js';
import { baseStaleRefusal } from './rules.js';
import { lockXact } from '../lib/advisory-lock.js';

export type SuggestionOutcome =
  | { ok: true; suggestion: SuggestionView; effect?: Effect; created?: boolean }
  | { ok: false; refusals: Refusal[] };

/** Runs `body` in a transaction; refusals it returns or throws roll everything back and come out. */
export async function inTx(
  body: (tx: Tx) => Promise<Refusal[] | null | undefined>,
): Promise<Refusal[] | null> {
  try {
    return await db.transaction(async (tx) => {
      const refusals = await body(tx);
      if (refusals?.length) throw new RefusalError(refusals, 'SUGGESTION_REFUSED');
      return null;
    });
  } catch (err) {
    if (err instanceof RefusalError) return [...err.refusals];
    throw err;
  }
}

/** Serialises every write on one target: a requirement's under its project's requirement lock, a feedback item's under its feedback lock. */
export async function lockTarget(tx: Tx, projectId: string, t: SuggestionTarget) {
  if (t.type === 'requirement') return lockRequirements(tx, projectId);
  if (t.type === 'feedback') return lockFeedback(tx, projectId);
  await lockXact(tx, 'suggestions', t.id);
}

export async function answer(id: string, extra: { effect?: Effect; created?: boolean } = {}) {
  const [row] = await db.select().from(suggestions).where(eq(suggestions.id, id));
  if (!row) throw new Error(`suggestions: ${id} vanished after its write`);
  return { ok: true as const, suggestion: viewOf(row), ...extra };
}

// cm:why a decision on an issue's suggestion is a typed record event (ISS-56) in the decision's own
// transaction; a requirement has no event stream yet (activity_log is keyed by issue), so there the
// row's status, decided_by, decided_at and reason are the record
export async function recordDecision(
  tx: Tx,
  row: Row,
  actor: SuggestionActor,
  outcome: string,
  reason?: string | null,
) {
  if (!row.issueId) return;
  await writeRecordEvent(
    {
      issueId: row.issueId,
      actor: { type: 'user', id: actor.userId, agency: actor.agency },
      kind: 'decision',
      contract: 1,
      fields: [
        { key: 'lead', value: `${row.kind} suggestion ${outcome}` },
        { key: 'suggestion', value: row.id },
        { key: 'outcome', value: outcome },
        ...(reason ? [{ key: 'reason', value: reason }] : []),
      ],
    },
    tx,
  );
}

/** A suggestion's base names a revision the head has moved past: the refusal names both. */
export function movedBase(row: Row, target: SuggestionTarget, head: number | null) {
  return target.type === 'requirement' ? baseStaleRefusal(row.baseRevision, head) : null;
}
