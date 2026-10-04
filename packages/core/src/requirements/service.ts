/**
 * Requirements (REQ-n): the business intent an issue serves, kept in immutable revisions with
 * stable BC criteria, agreed by a person into a baseline that pins the designs it was agreed
 * against. Workflow `requirement-lifecycle` rev 3; the guards are `rules.ts`, the reads `read.ts`,
 * the issue and design links `issue-links.ts`; these are the revision and agree writes, each in one
 * transaction under the project's requirement lock.
 */

import {
  type BaselineReadiness,
  REQUIREMENT_READINESS_GATE_DEFAULT,
  type RequirementReadinessGate,
} from '@forge/contracts/requirements';
import { REQUIREMENT_MACHINE } from '@forge/contracts/requirement-machine';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  type RequirementStatus,
  type RevisionState,
  requirementBaselines,
  requirementReturns,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { type KernelActor, notAnEdgeError, transition } from '../lifecycle/transition.js';
import { readProjectDocument } from '../project-config/service.js';
import { staleOnTargetRevised } from '../suggestions/stale.js';
import { linkedContracts, writePinsIn } from './baselines.js';
import { embedRequirementHeadLater } from './embeddings.js';
import {
  createRequirementIn,
  newDraftRevisionIn,
  type RevisionWrite,
  resetDraftCriteria,
  specOf,
  writeCriteria,
} from './revision-write.js';

export {
  createRequirementIn,
  newDraftRevisionIn,
  openRevisionOf,
  type RevisionWrite,
} from './revision-write.js';

import {
  detailOf,
  linkedDesigns,
  notFound,
  type RequirementActor,
  type RequirementDetail,
  type RevisionRow,
  type Row,
  readinessAt,
  requirementKey,
  rowIn,
  signerRefusal,
} from './read.js';
import {
  agreeRefusals,
  baselineReadiness,
  deferredRefusal,
  type LinkedDesign,
  type RequirementRefusal,
  readinessRefusal,
  reasonRefusal,
  staleBaseRefusal,
  stateRefusal,
} from './rules.js';
import { requireCan } from '../permissions/index.js';

async function readinessGateOf(projectId: string): Promise<RequirementReadinessGate> {
  const doc = await readProjectDocument(projectId);
  return doc?.document.requirements?.readinessGate ?? REQUIREMENT_READINESS_GATE_DEFAULT;
}

export type RequirementOutcome =
  | { ok: true; requirement: RequirementDetail; created?: boolean }
  | { ok: false; refusals: RequirementRefusal[] };

export async function lockRequirements(tx: Tx, projectId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`requirements:${projectId}`}, 0))`,
  );
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

class Refused extends Error {
  constructor(readonly refusals: RequirementRefusal[]) {
    super(refusals.map((r) => r.code).join(', '));
  }
}

/** Runs `body` in a transaction; a `Refused` rolls everything back and comes out as refusals. */
export function requirementKernelActor(actor: RequirementActor): KernelActor {
  return { type: 'user', id: actor.userId, agency: actor.agency };
}

export async function inTx(
  body: (tx: Tx) => Promise<RequirementRefusal[] | null | undefined>,
): Promise<RequirementRefusal[] | null> {
  try {
    return await db.transaction(async (tx) => {
      const refusals = await body(tx);
      if (refusals?.length) throw new Refused(refusals);
      return null;
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusals;
    throw err;
  }
}

export async function createRequirement(input: {
  projectId: string;
  actor: RequirementActor;
  title: string;
  write: RevisionWrite;
}): Promise<RequirementOutcome> {
  const { projectId, actor, write } = input;
  await requireCan({ userId: actor.userId }, 'project.write', projectId);
  const early = reasonRefusal(write.reason);
  if (early) return { ok: false, refusals: [early] };
  let id = '';
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const written = await createRequirementIn(tx, input);
    id = written.id;
    return written.refusals;
  });
  if (refusals) return { ok: false, refusals };
  return answer(projectId, id, actor, null, true);
}

/** A new draft revision on top of the head (`revision` absent), or an edit of the open draft. */
export async function writeRevision(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  /** Edit: the draft revision being rewritten. Absent: a new revision. */
  revision?: number | undefined;
  /** New: the head the revision is written against (null when there is none). */
  baseRevision?: number | null | undefined;
  write: RevisionWrite;
}): Promise<RequirementOutcome> {
  const { projectId, actor, write } = input;
  await requireCan({ userId: actor.userId }, 'project.write', projectId);
  const early = reasonRefusal(write.reason);
  if (early) return { ok: false, refusals: [early] };
  const row = await rowIn(db, projectId, input.ref);
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const [open] = await tx
      .select()
      .from(requirementRevisions)
      .where(
        and(
          eq(requirementRevisions.requirementId, row.id),
          inArray(requirementRevisions.state, ['draft', 'proposed']),
        ),
      );
    const content = {
      spec: specOf(write.spec),
      tldr: write.tldr ?? null,
      changeSummary: write.changeSummary ?? null,
      reason: write.reason.trim(),
    };
    if (input.revision === undefined) {
      return newDraftRevisionIn(tx, {
        requirementId: row.id,
        head: current.currentRevision,
        open: open ? { revision: open.revision, state: open.state as RevisionState } : null,
        baseRevision: input.baseRevision ?? null,
        actor,
        write,
      });
    }
    const [target] = await tx
      .select()
      .from(requirementRevisions)
      .where(
        and(
          eq(requirementRevisions.requirementId, row.id),
          eq(requirementRevisions.revision, input.revision),
        ),
      );
    if (!target) throw notFound(`${requirementKey(row.reqSeq)} has no revision ${input.revision}`);
    const notDraft = stateRefusal(target.revision, target.state as RevisionState, 'draft');
    if (notDraft) return [notDraft];
    await tx
      .update(requirementRevisions)
      .set({ ...content, authorId: actor.userId })
      .where(
        and(
          eq(requirementRevisions.requirementId, row.id),
          eq(requirementRevisions.revision, target.revision),
        ),
      );
    const own = await resetDraftCriteria(tx, row.id, target.revision);
    return writeCriteria(tx, row.id, target.revision, write.criteria, own);
  });
  return answer(projectId, row.id, actor, refusals);
}

async function revisionIn(tx: Tx, row: Row, revision: number): Promise<RevisionRow> {
  const [target] = await tx
    .select()
    .from(requirementRevisions)
    .where(
      and(
        eq(requirementRevisions.requirementId, row.id),
        eq(requirementRevisions.revision, revision),
      ),
    );
  if (!target) throw notFound(`${requirementKey(row.reqSeq)} has no revision ${revision}`);
  return target;
}

const revisionWhere = (requirementId: string, revision: number) =>
  and(
    eq(requirementRevisions.requirementId, requirementId),
    eq(requirementRevisions.revision, revision),
  );

/** An agent or a person puts the open draft in front of the BA or owner. */
export async function proposeRevision(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  revision: number;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  await requireCan({ userId: actor.userId }, 'project.write', projectId);
  const row = await rowIn(db, projectId, input.ref);
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const target = await revisionIn(tx, current, input.revision);
    const refusal =
      stateRefusal(target.revision, target.state as RevisionState, 'draft') ??
      staleBaseRefusal(target.baseRevision, current.currentRevision);
    if (refusal) return [refusal];
    await tx
      .update(requirementRevisions)
      .set({ state: 'proposed', proposedAt: new Date(), proposedBy: actor.userId })
      .where(revisionWhere(row.id, target.revision));
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}

/** The BA or owner sends a proposed revision back to draft, saying why. */
export async function returnRevision(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  revision: number;
  reason: string;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const signer = await signerRefusal(actor, projectId, 'returning a revision');
  if (signer) return { ok: false, refusals: [signer] };
  if (!input.reason.trim()) {
    return {
      ok: false,
      refusals: [
        {
          code: 'REVISION_REASON_REQUIRED',
          path: '/reason',
          detail: 'a returned revision says why.',
        },
      ],
    };
  }
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const target = await revisionIn(tx, row, input.revision);
    const refusal = stateRefusal(target.revision, target.state as RevisionState, 'proposed');
    if (refusal) return [refusal];
    await tx
      .update(requirementRevisions)
      .set({ state: 'draft', returnReason: input.reason.trim() })
      .where(revisionWhere(row.id, target.revision));
    await tx.insert(requirementReturns).values({
      requirementId: row.id,
      revision: target.revision,
      returnedBy: actor.userId,
      reason: input.reason.trim(),
    });
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}

/** Writes the agree's baseline of `revision` (seq 1) and its pins. */
async function writeBaseline(
  tx: Tx,
  requirementId: string,
  revision: number,
  designs: readonly LinkedDesign[],
  actor: RequirementActor,
  reason: string | null,
  readiness: BaselineReadiness | null = null,
) {
  const [baseline] = await tx
    .insert(requirementBaselines)
    .values({ requirementId, revision, agreedBy: actor.userId, reason, readiness })
    .returning({ seq: requirementBaselines.seq });
  if (!baseline) throw new Error(`requirements: no baseline row returned for ${requirementId}`);
  await writePinsIn(
    tx,
    { requirementId, revision, seq: baseline.seq },
    designs,
    await linkedContracts(tx, requirementId),
  );
}

/**
 * A person accepts the proposed revision: it becomes the head and the previous current is
 * superseded. After the agree it must pass every agree guard, and re-baselines in the same write.
 */
export async function acceptRevision(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  revision: number;
  /** The signer's own words; on an agreed requirement it is the re-baseline's reason. */
  reason?: string | null | undefined;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const signer = await signerRefusal(actor, projectId, 'accepting a revision');
  if (signer) return { ok: false, refusals: [signer] };
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const target = await revisionIn(tx, current, input.revision);
    const refusal =
      deferredRefusal(current.status as RequirementStatus, 'accepting a revision', '/revision') ??
      stateRefusal(target.revision, target.state as RevisionState, 'proposed') ??
      staleBaseRefusal(target.baseRevision, current.currentRevision);
    if (refusal) return [refusal];
    const rebaseline = current.status === 'agreed' || current.status === 'accepted';
    const designs = rebaseline ? await linkedDesigns(tx, row.id) : [];
    if (rebaseline) {
      const guards = agreeRefusals({
        status: current.status as RequirementStatus,
        named: target.revision,
        head: target.revision,
        headState: 'current',
        designs,
        rebaseline: true,
      });
      if (guards.length) return guards;
    }
    if (current.currentRevision !== null) {
      await tx
        .update(requirementRevisions)
        .set({ state: 'superseded' })
        .where(revisionWhere(row.id, current.currentRevision));
    }
    const acceptReason = input.reason?.trim() || null;
    await tx
      .update(requirementRevisions)
      .set({ state: 'current', decidedBy: actor.userId, decidedAt: new Date(), acceptReason })
      .where(revisionWhere(row.id, target.revision));
    await tx
      .update(requirements)
      .set({ currentRevision: target.revision, updatedAt: new Date() })
      .where(eq(requirements.id, row.id));
    if (rebaseline) {
      await transition(tx, REQUIREMENT_MACHINE, {
        to: 'agreed',
        from: 'accepted',
        set: { acceptedAt: null },
        where: eq(requirements.id, row.id),
        reason: acceptReason,
        actor: requirementKernelActor(actor),
        source: 'requirements',
        returning: ['id'],
      });
    }
    if (rebaseline) {
      // cm:why the baseline records who re-agreed and in their own words; the revision's reason is
      // its author's, already on the revision row
      await writeBaseline(tx, row.id, target.revision, designs, actor, acceptReason);
    }
    await staleOnTargetRevised(tx, row.id, target.revision);
    return null;
  });
  if (!refusals) embedRequirementHeadLater(row.id);
  return answer(projectId, row.id, actor, refusals);
}

/** A person signs the head off: draft → agreed, with a baseline pinning every linked design and contract. */
export async function agreeRequirement(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  revision: number;
  reason?: string | null | undefined;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const signer = await signerRefusal(actor, projectId, 'agreeing a requirement');
  if (signer) return { ok: false, refusals: [signer] };
  const gate = await readinessGateOf(projectId);
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const head =
      current.currentRevision === null
        ? null
        : await revisionIn(tx, current, current.currentRevision);
    const deferred = deferredRefusal(
      current.status as RequirementStatus,
      'agreeing it',
      '/revision',
    );
    if (deferred) return [deferred];
    const designs = await linkedDesigns(tx, row.id);
    const guards = agreeRefusals({
      status: current.status as RequirementStatus,
      named: input.revision,
      head: current.currentRevision,
      headState: (head?.state as RevisionState | undefined) ?? null,
      designs,
      rebaseline: false,
    });
    if (guards.length) return guards;
    const readiness = baselineReadiness(
      gate,
      current.currentRevision === null
        ? null
        : await readinessAt(tx, row.id, current.currentRevision),
    );
    const notReady = readinessRefusal(readiness, current.currentRevision);
    if (notReady) return [notReady];
    await writeBaseline(
      tx,
      row.id,
      input.revision,
      designs,
      actor,
      input.reason?.trim() || null,
      readiness,
    );
    const agreed = await transition(tx, REQUIREMENT_MACHINE, {
      to: 'agreed',
      from: 'draft',
      set: { updatedAt: new Date() },
      where: eq(requirements.id, row.id),
      reason: input.reason?.trim() || null,
      actor: requirementKernelActor(actor),
      source: 'requirements',
      returning: ['id'],
    });
    if (agreed.rows.length === 0) {
      throw notAnEdgeError(REQUIREMENT_MACHINE, current.status as RequirementStatus, 'agreed');
    }
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}
