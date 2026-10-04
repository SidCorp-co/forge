import { REQUIREMENT_MACHINE } from '@forge/contracts/requirement-machine';
import {
  type BaselineReadiness,
  REQUIREMENT_READINESS_GATE_DEFAULT,
  type RequirementReadinessGate,
} from '@forge/contracts/requirements';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  type RequirementStatus,
  type RevisionState,
  requirementBaselines,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { linkedContracts, writePinsIn } from './baselines.js';
import { requirementDependents } from './dependents.js';
import { embedRequirementHeadLater } from './embeddings.js';
import { linkedDesigns, type RequirementActor, readinessAt, rowIn, signerRefusal } from './read.js';
import {
  agreeRefusals,
  baselineReadiness,
  deferredRefusal,
  type LinkedDesign,
  readinessRefusal,
  staleBaseRefusal,
  stateRefusal,
} from './rules.js';
import {
  answer,
  inTx,
  lockRequirements,
  type RequirementOutcome,
  requirementKernelActor,
  revisionIn,
  revisionWhere,
} from './write-tx.js';

async function readinessGateOf(projectId: string): Promise<RequirementReadinessGate> {
  const doc = await readProjectDocument(projectId);
  return doc?.document.requirements?.readinessGate ?? REQUIREMENT_READINESS_GATE_DEFAULT;
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
      // The baseline records who re-agreed and in their own words; the revision's reason is its
      // author's, already on the revision row.
      await writeBaseline(tx, row.id, target.revision, designs, actor, acceptReason);
    }
    await requirementDependents().revised(tx, row.id, target.revision);
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
      expect: 'draft',
      set: { updatedAt: new Date() },
      where: eq(requirements.id, row.id),
      reason: input.reason?.trim() || null,
      actor: requirementKernelActor(actor),
      source: 'requirements',
      returning: ['id'],
    });
    movedRow(agreed);
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}
