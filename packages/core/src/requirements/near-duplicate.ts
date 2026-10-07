/**
 * The near-duplicate input of requirement-to-delivery `ready` ("a near-duplicate requirement exists
 * -> duplicate suggestion: merge or link before agreeing"): the requirements whose head vectors sit
 * within REQUIREMENT_NEAR_DUPLICATE_SIMILARITY of this head's, each with whether a duplicate
 * suggestion naming the pair was decided. The stored head vector is read, never a fresh embedding,
 * so a head with no vector (no provider, a no-egress policy, not embedded yet) is not compared: the
 * agree is not refused for it, and its readiness says dedup was not checked (the similar -> ready
 * edge's failure).
 */

import { say, sayEn } from '@forge/contracts/said';
import type { ActorAgency } from '@forge/contracts/permissions';
import {
  REQUIREMENT_NEAR_DUPLICATE_SIMILARITY,
  type RequirementDedupCheck,
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
  /** This agree filed `pendingId` itself. */
  filed?: boolean;
  /** Why the suggestions door refused to file one, where it did. */
  fileRefused?: string;
}

/** Proposes one duplicate suggestion on a requirement; the suggestions module answers it at boot. */
export type ProposeDuplicate = (input: {
  projectId: string;
  requirementId: string;
  baseRevision: number | null;
  duplicateOf: string;
  similarity: number;
  actor: { userId: string; agency: ActorAgency };
}) => Promise<{ ok: true; id: string } | { ok: false; refused: string }>;

/**
 * requirement-to-delivery `ready`: a near-duplicate with no decided and no proposed duplicate suggestion
 * gets one filed on this requirement, so the agree's refusal names a suggestion to decide rather than
 * asking the caller to write it. Run outside the agree's transaction, which its refusal rolls back.
 */
export async function fileUndecidedDuplicates(
  row: { id: string; projectId: string; currentRevision: number | null },
  actor: { userId: string; agency: ActorAgency },
  near: readonly NearDuplicate[],
  propose: ProposeDuplicate,
): Promise<NearDuplicate[]> {
  const out: NearDuplicate[] = [];
  for (const n of near) {
    if (n.decided || n.pendingId) {
      out.push(n);
      continue;
    }
    const filed = await propose({
      projectId: row.projectId,
      requirementId: row.id,
      baseRevision: row.currentRevision,
      duplicateOf: n.key,
      similarity: n.similarity,
      actor,
    });
    out.push(
      filed.ok ? { ...n, pendingId: filed.id, filed: true } : { ...n, fileRefused: filed.refused },
    );
  }
  return out;
}

/** Refused while any near-duplicate has no decided duplicate suggestion naming it. */
export function nearDuplicateRefusal(
  key: string,
  near: readonly NearDuplicate[],
): RequirementRefusal | null {
  const open = near.filter((n) => !n.decided);
  if (open.length === 0) return null;
  const named = open
    .map((n) => {
      const sugg = n.pendingId
        ? `duplicate suggestion ${n.pendingId} ${n.filed ? 'was filed by this agree' : 'is proposed'}`
        : n.fileRefused
          ? `no duplicate suggestion could be filed (${n.fileRefused})`
          : 'no duplicate suggestion proposed';
      return `${n.key} (similarity ${n.similarity}, ${sugg})`;
    })
    .join(', ');
  return {
    code: 'REQUIREMENT_DUPLICATE_UNDECIDED',
    path: '/revision',
    detail: `${key} reads as a near-duplicate of ${named}. Decide a duplicate suggestion on ${key} naming each first: accept it to merge (${key} is dropped as the duplicate), or reject it with a reason to keep both.`,
  };
}

const named = (payload: unknown): string | null => {
  const of = (payload as { duplicateOf?: unknown } | null)?.duplicateOf;
  return typeof of === 'string' ? of.trim().toUpperCase() : null;
};

type StoredVector = Awaited<ReturnType<typeof itemEmbeddingOf>>;

function checkOf(own: StoredVector): RequirementDedupCheck {
  if (own?.status === 'embedded' && own.embedding && own.model) return { ran: true };
  const why = own
    ? say('requirements.dedup.notChecked', { status: own.status })
    : say('requirements.dedup.notWritten');
  return { ran: false, why: sayEn(why), says: { why } };
}

/** Whether `requirementId`'s head holds a vector an agree can compare. */
export async function dedupCheckOf(requirementId: string): Promise<RequirementDedupCheck> {
  return checkOf(await itemEmbeddingOf({ requirementId }));
}

export interface NearDuplicateRead {
  check: RequirementDedupCheck;
  near: NearDuplicate[];
}

/** The near-duplicates of `row`'s head, and whether its head had a vector to compare at all. */
export async function nearDuplicatesOf(row: {
  id: string;
  projectId: string;
  reqSeq: number;
  currentRevision: number | null;
}): Promise<NearDuplicateRead> {
  const own = await itemEmbeddingOf({ requirementId: row.id });
  const check = checkOf(own);
  if (!check.ran || !own?.embedding || !own.model) return { check, near: [] };
  return { check, near: await nearOf(row, own.embedding, own.model) };
}

async function nearOf(
  row: { id: string; projectId: string; reqSeq: number; currentRevision: number | null },
  embedding: number[],
  model: string,
): Promise<NearDuplicate[]> {
  const nearest = (
    await nearestItems({
      projectId: row.projectId,
      kind: 'requirement',
      vector: embedding,
      model,
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
