import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  type RequirementStatus,
  type RevisionState,
  requirementBaselines,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { latestBaselineIn, linkedContracts, writePinsIn } from './baselines.js';
import { linkedDesigns, type RequirementActor, rowIn, signerRefusal } from './read.js';
import { type RequirementRefusal, repinRefusals } from './rules.js';
import { answer, inTx, lockRequirements, type RequirementOutcome } from './write-tx.js';

// When a linked design is approved past the revision the agreed baseline pins, or a linked
// contract has a newer approved version, a person writes a further baseline of the same head
// revision pinning each linked design's approved revision and each linked contract's current
// version, with no text revision; the earlier baseline stays, and an issue whose plan read it
// reads changed-since-plan until it is re-planned; the text is unchanged, so the readiness result
// the agree recorded carries over (ISS-86, ISS-98); no picture or mockup is pinned, so neither makes
// a re-pin due (Requirement lifecycle r14 `agreed`). A design approval that removes or renames no step
// a current criterion traces is followed without a person, by the kernel (`auto-follow.ts`, REQ-41 BC-10)
export async function repinRequirement(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  revision: number;
  reason?: string | null | undefined;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const signer = await signerRefusal(actor, projectId, 're-pinning a requirement', row);
  if (signer) return { ok: false, refusals: [signer] };
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    return repinIn(tx, {
      projectId,
      requirementId: row.id,
      revision: input.revision,
      by: actor.userId,
      reason: input.reason,
    });
  });
  return answer(projectId, row.id, actor, refusals);
}

/**
 * The re-pin itself, inside a transaction holding the project's requirement lock: every guard the
 * act has, then a further baseline of the head pinning each linked design's approved revision and
 * each linked contract's current version. A person's act reaches it through `repinRequirement`
 * after the signer check; the kernel's follow of an approved design (`auto-follow.ts`, REQ-41
 * BC-10) reaches it directly, recording `by` as the approver whose act it follows.
 */
export async function repinIn(
  tx: Tx,
  input: {
    projectId: string;
    requirementId: string;
    revision: number;
    by: string;
    reason?: string | null | undefined;
  },
): Promise<RequirementRefusal[] | null> {
  const current = await rowIn(tx, input.projectId, input.requirementId);
  const head = current.currentRevision;
  const [headRow] =
    head === null
      ? []
      : await tx
          .select({ state: requirementRevisions.state })
          .from(requirementRevisions)
          .where(
            and(
              eq(requirementRevisions.requirementId, current.id),
              eq(requirementRevisions.revision, head),
            ),
          );
  const headState = (headRow?.state ?? null) as RevisionState | null;
  const designs = await linkedDesigns(tx, current.id);
  const contracts = await linkedContracts(tx, current.id);
  const latest = head === null ? null : await latestBaselineIn(tx, current.id, head);
  const refused = repinRefusals({
    status: current.status as RequirementStatus,
    named: input.revision,
    head,
    headState,
    designs,
    pins:
      latest?.pins.flatMap((p) =>
        p.workflowId && p.designRevision !== null
          ? [{ workflowId: p.workflowId, designRevision: p.designRevision }]
          : [],
      ) ?? null,
    contracts,
    contractPins:
      latest?.pins.flatMap((p) =>
        p.providerProjectId && p.contractSlug && p.contractVersion
          ? [
              {
                providerProjectId: p.providerProjectId,
                contractSlug: p.contractSlug,
                contractVersion: p.contractVersion,
              },
            ]
          : [],
      ) ?? [],
  });
  if (refused.length || head === null || !latest) return refused;
  const seq = latest.seq + 1;
  await tx.insert(requirementBaselines).values({
    requirementId: current.id,
    revision: head,
    seq,
    act: 'repin',
    agreedBy: input.by,
    reason: input.reason?.trim() || null,
    readiness: latest.readiness,
  });
  await writePinsIn(tx, { requirementId: current.id, revision: head, seq }, designs, contracts);
  await tx
    .update(requirements)
    .set({ updatedAt: new Date() })
    .where(eq(requirements.id, current.id));
  return null;
}
