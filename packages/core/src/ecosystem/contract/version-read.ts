import { and, desc, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { contractArtifacts, contractVersions } from '../../db/schema-ecosystem.js';
import type { ContractVersionFact, ContractVersionReads } from '../../lib/contract-versions.js';
import { currentOf } from './store.js';
import { contractWaitTargetIn } from './waits.js';

async function versionsOf(
  tx: Tx,
  providerProjectIds: readonly string[],
  contractSlugs?: readonly string[],
): Promise<ContractVersionFact[]> {
  if (providerProjectIds.length === 0 || contractSlugs?.length === 0) return [];
  return tx
    .select({
      providerProjectId: contractVersions.providerProjectId,
      contractSlug: contractVersions.contractSlug,
      version: contractVersions.version,
      approval: contractVersions.approval,
      contractType: contractVersions.contractType,
      elements: contractVersions.elements,
      artifactSha256: contractVersions.artifactSha256,
      breakingElements: sql<string[]>`coalesce((
        SELECT array_agg(c->>'element') FROM jsonb_array_elements(${contractVersions.document}->'diff'->'changes') c
         WHERE c->>'level' = 'breaking'), '{}')`,
    })
    .from(contractVersions)
    .where(
      and(
        inArray(contractVersions.providerProjectId, [...new Set(providerProjectIds)]),
        contractSlugs
          ? inArray(contractVersions.contractSlug, [...new Set(contractSlugs)])
          : undefined,
      ),
    )
    .orderBy(desc(contractVersions.recordedAt));
}

/** What the lower contexts read of contract versions, through `lib/contract-versions.ts`. */
export const contractVersionReads: ContractVersionReads = {
  versionsOf,
  async currentVersionsOf(tx, providerProjectIds) {
    const byContract = new Map<string, ContractVersionFact[]>();
    for (const v of await versionsOf(tx, providerProjectIds)) {
      const key = `${v.providerProjectId}\u0000${v.contractSlug}`;
      const versions = byContract.get(key);
      if (versions) versions.push(v);
      else byContract.set(key, [v]);
    }
    return [...byContract.values()].flatMap((versions) => currentOf(versions) ?? []);
  },
  async artifactsOf(shas) {
    if (shas.length === 0) return new Map();
    const rows = await db
      .select({ sha256: contractArtifacts.sha256, content: contractArtifacts.content })
      .from(contractArtifacts)
      .where(inArray(contractArtifacts.sha256, [...new Set(shas)]));
    return new Map(rows.map((r) => [r.sha256, r.content]));
  },
  waitTargetIn: contractWaitTargetIn,
};
