/**
 * Requirements (REQ-n), workflow `requirement-lifecycle`: the revision writes (create, write, propose,
 * return), each in one transaction under the project's requirement lock. Accept and agree are
 * `agree.ts`, the guards `rules.ts`, the reads `read.ts`.
 */

import { db } from '../db/client.js';
import {
  type RevisionState,
  requirementReturns,
  requirementRevisions,
} from '../db/schema-requirements.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { type RequirementActor, rowIn, signerRefusal } from './read.js';
import {
  createRequirementIn,
  newDraftRevisionIn,
  type RevisionWrite,
  resetDraftCriteria,
  specOf,
  storedWrite,
  writeCriteria,
} from './revision-write.js';
import { reasonRefusal, staleBaseRefusal, stateRefusal } from './rules.js';
import {
  answer,
  inTx,
  lockRequirements,
  type RequirementOutcome,
  revisionIn,
  revisionWhere,
} from './write-tx.js';

export async function createRequirement(input: {
  projectId: string;
  actor: RequirementActor;
  title: string;
  write: RevisionWrite;
}): Promise<RequirementOutcome> {
  const { projectId, actor, write } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
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
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const early = reasonRefusal(write.reason);
  if (early) return { ok: false, refusals: [early] };
  const row = await rowIn(db, projectId, input.ref);
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    if (input.revision === undefined) {
      return newDraftRevisionIn(tx, {
        requirementId: row.id,
        head: current.currentRevision,
        baseRevision: input.baseRevision ?? null,
        actor,
        write,
      });
    }
    const target = await revisionIn(tx, current, input.revision);
    const notDraft = stateRefusal(target.revision, target.state as RevisionState, 'draft');
    if (notDraft) return [notDraft];
    const stored = storedWrite(await dataPolicyOf(projectId), write);
    await tx
      .update(requirementRevisions)
      .set({
        spec: specOf(stored.spec),
        tldr: stored.tldr ?? null,
        changeSummary: stored.changeSummary ?? null,
        reason: stored.reason.trim(),
        authorId: actor.userId,
      })
      .where(revisionWhere(row.id, target.revision));
    const own = await resetDraftCriteria(tx, row.id, target.revision);
    return writeCriteria(tx, row.id, target.revision, stored.criteria, own);
  });
  return answer(projectId, row.id, actor, refusals);
}

/** An agent or a person puts the open draft in front of the BA or owner. */
export async function proposeRevision(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  revision: number;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
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
  const reason = storedText(await dataPolicyOf(projectId), input.reason.trim()).text;
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const target = await revisionIn(tx, row, input.revision);
    const refusal = stateRefusal(target.revision, target.state as RevisionState, 'proposed');
    if (refusal) return [refusal];
    await tx
      .update(requirementRevisions)
      .set({ state: 'draft', returnReason: reason })
      .where(revisionWhere(row.id, target.revision));
    await tx.insert(requirementReturns).values({
      requirementId: row.id,
      revision: target.revision,
      returnedBy: actor.userId,
      reason,
    });
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}
