import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { projects } from '../db/schema.js';
import {
  requirementBaselinePins,
  requirementBaselines,
  requirementContracts,
} from '../db/schema-requirements.js';
import { contractVersionReads } from '../lib/contract-versions.js';
import { refuseUnindexedBindings } from './bindings.js';
import type { LinkedContract, LinkedDesign } from './rules.js';

// An agree writes seq 1 and each re-pin a further seq of the same revision, so the latest
// baseline of a revision is the highest seq there (ISS-86)
export async function latestBaselineIn(tx: Tx, requirementId: string, revision: number) {
  const [b] = await tx
    .select({ seq: requirementBaselines.seq, readiness: requirementBaselines.readiness })
    .from(requirementBaselines)
    .where(
      and(
        eq(requirementBaselines.requirementId, requirementId),
        eq(requirementBaselines.revision, revision),
      ),
    )
    .orderBy(desc(requirementBaselines.seq))
    .limit(1);
  if (!b) return null;
  const pins = await tx
    .select()
    .from(requirementBaselinePins)
    .where(
      and(
        eq(requirementBaselinePins.requirementId, requirementId),
        eq(requirementBaselinePins.revision, revision),
        eq(requirementBaselinePins.baselineSeq, b.seq),
      ),
    );
  return { seq: b.seq, readiness: b.readiness, pins };
}

/**
 * The one pin writer: an agree, an accept that re-baselines and a re-pin all pin each linked
 * design's approved revision, each linked contract's current version (none while no version is
 * approved), into the baseline `(revision, seq)` already written. A pinned design that binds a
 * contract no element index reads is refused REQUIREMENT_BINDING_NOT_INDEXED. No baseline pins the
 * requirement's picture or a mockup (Requirement lifecycle r14 `agreed`, Requirement to delivery
 * r15 `pins`): the picture is replaced in place, so pinning it would move nothing a plan reads. Mockup
 * pins written before REQ-35 stay as the record of what those baselines agreed.
 */
export async function writePinsIn(
  tx: Tx,
  at: { requirementId: string; revision: number; seq: number },
  designs: readonly LinkedDesign[],
  contracts: readonly LinkedContract[],
): Promise<number> {
  await refuseUnindexedBindings(
    tx,
    designs.flatMap((d) =>
      d.approvedRevision === null
        ? []
        : [{ workflowId: d.workflowId, flow: d.flow, designRevision: d.approvedRevision }],
    ),
  );
  const base = { requirementId: at.requirementId, revision: at.revision, baselineSeq: at.seq };
  const pins = [
    ...designs.flatMap((d) =>
      d.approvedRevision === null
        ? []
        : [{ ...base, workflowId: d.workflowId, designRevision: d.approvedRevision }],
    ),
    ...contracts.flatMap((c) =>
      c.currentVersion === null
        ? []
        : [
            {
              ...base,
              providerProjectId: c.providerProjectId,
              contractSlug: c.contractSlug,
              contractVersion: c.currentVersion,
            },
          ],
    ),
  ];
  if (pins.length) await tx.insert(requirementBaselinePins).values(pins);
  return pins.length;
}

/** Each contract each of `requirementIds` links, with its newest approved version. */
export async function linkedContractsOf(
  tx: Tx,
  requirementIds: readonly string[],
): Promise<(LinkedContract & { requirementId: string })[]> {
  if (requirementIds.length === 0) return [];
  const links = await tx
    .select({
      requirementId: requirementContracts.requirementId,
      providerProjectId: requirementContracts.providerProjectId,
      contractSlug: requirementContracts.contractSlug,
      project: projects.slug,
    })
    .from(requirementContracts)
    .innerJoin(projects, eq(projects.id, requirementContracts.providerProjectId))
    .where(inArray(requirementContracts.requirementId, [...requirementIds]))
    .orderBy(asc(projects.slug), asc(requirementContracts.contractSlug));
  if (links.length === 0) return [];
  const approved = await contractVersionReads().currentVersionsOf(tx, [
    ...new Set(links.map((l) => l.providerProjectId)),
  ]);
  return links.map((l) => ({
    requirementId: l.requirementId,
    providerProjectId: l.providerProjectId,
    contract: `${l.project}/${l.contractSlug}`,
    contractSlug: l.contractSlug,
    currentVersion:
      approved.find(
        (v) => v.providerProjectId === l.providerProjectId && v.contractSlug === l.contractSlug,
      )?.version ?? null,
  }));
}

/** Each contract `requirementId` links, with its newest approved version. */
export async function linkedContracts(tx: Tx, requirementId: string): Promise<LinkedContract[]> {
  return (await linkedContractsOf(tx, [requirementId])).map(({ requirementId: _, ...c }) => c);
}
