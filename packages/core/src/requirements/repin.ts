import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type RequirementStatus,
  type RevisionState,
  requirementBaselinePins,
  requirementBaselines,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { latestBaselineIn } from './baselines.js';
import { linkedDesigns, type RequirementActor, rowIn, signerRefusal } from './read.js';
import { repinRefusals } from './rules.js';
import { answer, inTx, lockRequirements, type RequirementOutcome } from './service.js';

// cm:why when a linked design is approved past the revision the agreed baseline pins, a person
// writes a further baseline of the same head revision pinning each linked design's approved
// revision, with no text revision; the earlier baseline stays, and an issue whose plan read it
// reads changed-since-plan until it is re-planned; the text is unchanged, so the readiness result
// the agree recorded carries over (ISS-86, ISS-98)
export async function repinRequirement(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  revision: number;
  reason?: string | null | undefined;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const signer = await signerRefusal(actor, projectId, 're-pinning a requirement');
  if (signer) return { ok: false, refusals: [signer] };
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const head = current.currentRevision;
    const [headRow] =
      head === null
        ? []
        : await tx
            .select({ state: requirementRevisions.state })
            .from(requirementRevisions)
            .where(
              and(
                eq(requirementRevisions.requirementId, row.id),
                eq(requirementRevisions.revision, head),
              ),
            );
    const headState = (headRow?.state ?? null) as RevisionState | null;
    const designs = await linkedDesigns(tx, row.id);
    const latest = head === null ? null : await latestBaselineIn(tx, row.id, head);
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
    });
    if (refused.length || head === null || !latest) return refused;
    const seq = latest.seq + 1;
    await tx.insert(requirementBaselines).values({
      requirementId: row.id,
      revision: head,
      seq,
      act: 'repin',
      agreedBy: actor.userId,
      reason: input.reason?.trim() || null,
      readiness: latest.readiness,
    });
    const pins = [
      ...designs.flatMap((d) =>
        d.approvedRevision === null
          ? []
          : [{ workflowId: d.workflowId, designRevision: d.approvedRevision }],
      ),
      ...latest.pins.flatMap((p) =>
        p.contractSlug
          ? [
              {
                providerProjectId: p.providerProjectId,
                contractSlug: p.contractSlug,
                contractVersion: p.contractVersion,
              },
            ]
          : [],
      ),
    ];
    if (pins.length) {
      await tx
        .insert(requirementBaselinePins)
        .values(
          pins.map((p) => ({ requirementId: row.id, revision: head, baselineSeq: seq, ...p })),
        );
    }
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, row.id));
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}
