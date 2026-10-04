import { requirementKey } from '@forge/contracts/requirements';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { requirementRevisions } from '../db/schema-requirements.js';
import { lockXact } from '../lib/advisory-lock.js';
import { RefusalError } from '../lib/refusal.js';
import type { KernelActor } from '../lifecycle/index.js';
import {
  detailOf,
  notFound,
  type RequirementActor,
  type RequirementDetail,
  type RevisionRow,
  type Row,
  rowIn,
} from './read.js';
import type { RequirementRefusal } from './rules.js';

export type RequirementOutcome =
  | { ok: true; requirement: RequirementDetail; created?: boolean }
  | { ok: false; refusals: RequirementRefusal[] };

export async function lockRequirements(tx: Tx, projectId: string): Promise<void> {
  await lockXact(tx, 'requirements', projectId);
}

export async function answer(
  projectId: string,
  id: string,
  viewer: RequirementActor,
  refusals: RequirementRefusal[] | null,
  created = false,
): Promise<RequirementOutcome> {
  if (refusals?.length) return { ok: false, refusals };
  return {
    ok: true,
    requirement: await detailOf(await rowIn(db, projectId, id), viewer),
    ...(created ? { created } : {}),
  };
}

export function requirementKernelActor(actor: RequirementActor): KernelActor {
  return { type: 'user', id: actor.userId, agency: actor.agency };
}

/** Runs `body` in a transaction; a refusal rolls everything back and comes out as refusals. */
export async function inTx(
  body: (tx: Tx) => Promise<RequirementRefusal[] | null | undefined>,
): Promise<RequirementRefusal[] | null> {
  try {
    return await db.transaction(async (tx) => {
      const refusals = await body(tx);
      if (refusals?.length) throw new RefusalError(refusals, 'REQUIREMENT_REFUSED');
      return null;
    });
  } catch (err) {
    if (err instanceof RefusalError) return err.refusals as RequirementRefusal[];
    throw err;
  }
}

export const revisionWhere = (requirementId: string, revision: number) =>
  and(
    eq(requirementRevisions.requirementId, requirementId),
    eq(requirementRevisions.revision, revision),
  );

export async function revisionIn(tx: Tx, row: Row, revision: number): Promise<RevisionRow> {
  const [target] = await tx
    .select()
    .from(requirementRevisions)
    .where(revisionWhere(row.id, revision));
  if (!target) throw notFound(`${requirementKey(row.reqSeq)} has no revision ${revision}`);
  return target;
}
