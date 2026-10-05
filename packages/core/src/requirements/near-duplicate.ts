/**
 * The near-duplicate input of requirement-to-delivery `ready` ("a near-duplicate requirement exists
 * -> duplicate suggestion: merge or link before agreeing"): the requirements whose head vectors sit
 * within REQUIREMENT_NEAR_DUPLICATE_SIMILARITY of this head's, each with whether a duplicate
 * suggestion naming the pair was decided. The stored head vector is read, never a fresh embedding,
 * so a head with no vector (no provider, a no-egress policy, not embedded yet) is not compared and
 * the agree is not refused for it.
 */

import {
  REQUIREMENT_NEAR_DUPLICATE_SIMILARITY,
  requirementKey,
} from '@forge/contracts/requirements';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { itemEmbeddingOf, nearestItems } from '../knowledge/index.js';
import type { RequirementRefusal } from './rules.js';

export interface NearDuplicate {
  key: string;
  similarity: number;
  /** A duplicate suggestion naming the pair was accepted or rejected (on this one, at its head). */
  decided: boolean;
  /** The proposed duplicate suggestion naming the pair, waiting on a decision. */
  pendingId: string | null;
}

/** Refused while any near-duplicate has no decided duplicate suggestion naming it. */
export function nearDuplicateRefusal(
  key: string,
  near: readonly NearDuplicate[],
): RequirementRefusal | null {
  const open = near.filter((n) => !n.decided);
  if (open.length === 0) return null;
  const named = open
    .map(
      (n) =>
        `${n.key} (similarity ${n.similarity}${n.pendingId ? `, duplicate suggestion ${n.pendingId} is proposed` : ', no duplicate suggestion proposed'})`,
    )
    .join(', ');
  return {
    code: 'REQUIREMENT_DUPLICATE_UNDECIDED',
    path: '/revision',
    detail: `${key} reads as a near-duplicate of ${named}. Decide a duplicate suggestion on ${key} naming each first: accept it to merge (${key} is dropped as the duplicate), or reject it with a reason to keep both; where none is proposed, propose one (kind duplicate, payload.duplicateOf).`,
  };
}

const named = (payload: unknown): string | null => {
  const of = (payload as { duplicateOf?: unknown } | null)?.duplicateOf;
  return typeof of === 'string' ? of.trim().toUpperCase() : null;
};

/** The near-duplicates of `row`'s head, or none when its head has no vector to compare. */
export async function nearDuplicatesOf(row: {
  id: string;
  projectId: string;
  reqSeq: number;
  currentRevision: number | null;
}): Promise<NearDuplicate[]> {
  const own = await itemEmbeddingOf({ requirementId: row.id });
  if (own?.status !== 'embedded' || !own.embedding || !own.model) return [];
  const nearest = (
    await nearestItems({
      projectId: row.projectId,
      kind: 'requirement',
      vector: own.embedding,
      model: own.model,
      exclude: row.id,
      limit: 5,
    })
  ).filter((n) => n.similarity >= REQUIREMENT_NEAR_DUPLICATE_SIMILARITY);
  if (nearest.length === 0) return [];
  const rows = await db
    .select({ id: requirements.id, seq: requirements.reqSeq })
    .from(requirements)
    .where(
      and(
        inArray(
          requirements.id,
          nearest.map((n) => n.itemId),
        ),
        ne(requirements.status, 'dropped'),
      ),
    );
  if (rows.length === 0) return [];
  const dups = await db
    .select({
      id: suggestions.id,
      requirementId: suggestions.requirementId,
      status: suggestions.status,
      baseRevision: suggestions.baseRevision,
      payload: suggestions.payload,
    })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.kind, 'duplicate'),
        inArray(suggestions.requirementId, [row.id, ...rows.map((r) => r.id)]),
      ),
    );
  const mine = requirementKey(row.reqSeq);
  return nearest.flatMap((n) => {
    const other = rows.find((r) => r.id === n.itemId);
    if (!other) return [];
    const key = requirementKey(other.seq);
    const pair = dups.filter(
      (d) =>
        (d.requirementId === row.id &&
          [key, other.id.toUpperCase()].includes(named(d.payload) ?? '')) ||
        (d.requirementId === other.id &&
          [mine, row.id.toUpperCase()].includes(named(d.payload) ?? '')),
    );
    const decided = pair.some(
      (d) =>
        (d.status === 'accepted' || d.status === 'rejected') &&
        (d.requirementId !== row.id || d.baseRevision === row.currentRevision),
    );
    const pending = pair.find((d) => d.status === 'proposed');
    return [{ key, similarity: n.similarity, decided, pendingId: pending?.id ?? null }];
  });
}
