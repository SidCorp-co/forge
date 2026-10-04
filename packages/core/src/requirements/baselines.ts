import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { projects } from '../db/schema.js';
import { contractVersions } from '../db/schema-ecosystem.js';
import { mockups } from '../db/schema-mockups.js';
import {
  requirementBaselinePins,
  requirementBaselines,
  requirementContracts,
} from '../db/schema-requirements.js';
import type { LinkedContract, LinkedDesign } from './rules.js';

// cm:why an agree writes seq 1 and each re-pin a further seq of the same revision, so the latest
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

export async function plannedBaselineSeqIn(
  tx: Tx,
  requirementId: string,
  revision: number | null,
): Promise<number | null> {
  if (revision === null) return null;
  return (await latestBaselineIn(tx, requirementId, revision))?.seq ?? null;
}

// cm:why a baseline pins every accepted mockup proposed against its revision or an earlier one,
// beside the designs (ISS-78): a mockup's bytes never change, so the pin is the row
export async function acceptedMockupIds(
  tx: Tx,
  requirementId: string,
  revision: number,
): Promise<string[]> {
  const rows = await tx
    .select({ id: mockups.id })
    .from(mockups)
    .where(
      and(
        eq(mockups.requirementId, requirementId),
        eq(mockups.status, 'accepted'),
        lte(mockups.revision, revision),
      ),
    )
    .orderBy(asc(mockups.mockupSeq));
  return rows.map((r) => r.id);
}

/**
 * The one pin writer: an agree, an accept that re-baselines and a re-pin all pin each linked
 * design's approved revision, each linked contract's current version (none while no version is
 * approved) and each accepted mockup, into the baseline `(revision, seq)` already written.
 */
export async function writePinsIn(
  tx: Tx,
  at: { requirementId: string; revision: number; seq: number },
  designs: readonly LinkedDesign[],
  contracts: readonly LinkedContract[],
): Promise<number> {
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
    ...(await acceptedMockupIds(tx, at.requirementId, at.revision)).map((mockupId) => ({
      ...base,
      mockupId,
    })),
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
  const approved = await tx
    .select({
      providerProjectId: contractVersions.providerProjectId,
      contractSlug: contractVersions.contractSlug,
      version: contractVersions.version,
    })
    .from(contractVersions)
    .where(
      and(
        inArray(contractVersions.providerProjectId, [
          ...new Set(links.map((l) => l.providerProjectId)),
        ]),
        eq(contractVersions.approval, 'approved'),
      ),
    )
    .orderBy(desc(contractVersions.recordedAt));
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
