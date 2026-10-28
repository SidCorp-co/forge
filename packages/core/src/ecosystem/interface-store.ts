import { and, desc, eq, inArray } from 'drizzle-orm';
import { agentAccountsAmong } from '../auth/index.js';
import { db, type Tx } from '../db/client.js';
import {
  ecosystemConsumptions,
  ecosystemMemberships,
  projectInterfaceRevisions,
  projectInterfaces,
} from '../db/schema-ecosystem.js';
import { listProjectHeads } from '../projects/index.js';
import type { RevisionBy } from './provider-writer-rules.js';
import type { StoredDocument, StoredRevision } from './store.js';

export async function readInterface(tx: Tx, projectId: string): Promise<StoredDocument | null> {
  const [row] = await tx
    .select()
    .from(projectInterfaces)
    .where(eq(projectInterfaces.projectId, projectId))
    .limit(1);
  return row ?? null;
}

export async function readInterfaces(
  tx: Tx,
  projectIds: readonly string[],
): Promise<Map<string, StoredDocument>> {
  if (projectIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(projectInterfaces)
    .where(inArray(projectInterfaces.projectId, [...projectIds]));
  return new Map(rows.map((r) => [r.projectId, r]));
}

export interface EdgeRow {
  consumerProjectId: string;
  providerProjectId: string;
  contractSlug: string;
  ecosystemId: string;
  builtAgainst: string;
}

/** Why an adopt crossed versions no differ measured additive, kept on the revision it writes (REQ-5 BC-15). */
export interface AdoptedUnmeasured {
  reason: string;
  versions: readonly { version: string; measured: string }[];
}

export async function putInterface(
  tx: Tx,
  input: {
    projectId: string;
    revision: number;
    userId: string;
    adoptedUnmeasured?: AdoptedUnmeasured | null;
  },
  document: unknown,
  edges: readonly EdgeRow[],
): Promise<StoredDocument> {
  const { projectId, revision, userId } = input;
  const now = new Date();
  const values = { projectId, revision, document, updatedBy: userId, updatedAt: now };
  const [row] = await tx
    .insert(projectInterfaces)
    .values(values)
    .onConflictDoUpdate({ target: projectInterfaces.projectId, set: values })
    .returning();
  const adopted = input.adoptedUnmeasured ?? null;
  await tx.insert(projectInterfaceRevisions).values({
    projectId,
    revision,
    document,
    writtenBy: userId,
    writtenAt: now,
    adoptReason: adopted?.reason ?? null,
    adoptUnmeasured: adopted ? [...adopted.versions] : null,
  });
  await tx
    .delete(ecosystemConsumptions)
    .where(eq(ecosystemConsumptions.consumerProjectId, projectId));
  if (edges.length > 0) await tx.insert(ecosystemConsumptions).values([...edges]);
  if (!row) throw new Error('ecosystem: the interface upsert returned no row');
  return row;
}

export async function listInterfaceRevisions(
  projectId: string,
): Promise<(StoredRevision & { adoptedUnmeasured: AdoptedUnmeasured | null })[]> {
  const rows = await db
    .select({
      revision: projectInterfaceRevisions.revision,
      document: projectInterfaceRevisions.document,
      writtenBy: projectInterfaceRevisions.writtenBy,
      writtenAt: projectInterfaceRevisions.writtenAt,
      adoptReason: projectInterfaceRevisions.adoptReason,
      adoptUnmeasured: projectInterfaceRevisions.adoptUnmeasured,
    })
    .from(projectInterfaceRevisions)
    .where(eq(projectInterfaceRevisions.projectId, projectId))
    .orderBy(desc(projectInterfaceRevisions.revision));
  return rows.map(({ adoptReason, adoptUnmeasured, ...r }) => ({
    ...r,
    adoptedUnmeasured:
      adoptReason === null
        ? null
        : { reason: adoptReason, versions: adoptUnmeasured as AdoptedUnmeasured['versions'] },
  }));
}

/** Each revision of a project's interface, newest first, with the agency of the account that wrote it. */
export async function interfaceRevisionsBy(projectId: string): Promise<RevisionBy[]> {
  const rows = await listInterfaceRevisions(projectId);
  const agents = await agentAccountsAmong(rows.map((r) => r.writtenBy));
  return rows.map((r) => ({ ...r, agency: agents.has(r.writtenBy) ? 'agent' : 'human' }));
}

export async function edgesIn(tx: Tx, ecosystemIds: readonly string[]): Promise<EdgeRow[]> {
  if (ecosystemIds.length === 0) return [];
  return tx
    .select()
    .from(ecosystemConsumptions)
    .where(inArray(ecosystemConsumptions.ecosystemId, [...ecosystemIds]));
}

export async function consumersOf(
  tx: Tx,
  providerId: string,
): Promise<
  { consumerId: string; consumerSlug: string; contractSlug: string; ecosystemId: string }[]
> {
  const edges = await tx
    .select({
      consumerId: ecosystemConsumptions.consumerProjectId,
      contractSlug: ecosystemConsumptions.contractSlug,
      ecosystemId: ecosystemConsumptions.ecosystemId,
    })
    .from(ecosystemConsumptions)
    .innerJoin(
      ecosystemMemberships,
      and(
        eq(ecosystemMemberships.projectId, ecosystemConsumptions.consumerProjectId),
        eq(ecosystemMemberships.ecosystemId, ecosystemConsumptions.ecosystemId),
        eq(ecosystemMemberships.state, 'active'),
      ),
    )
    .where(eq(ecosystemConsumptions.providerProjectId, providerId));
  if (edges.length === 0) return [];
  const slugs = new Map(
    (await listProjectHeads([...new Set(edges.map((e) => e.consumerId))])).map((p) => [
      p.id,
      p.slug,
    ]),
  );
  return edges.flatMap((e) => {
    const consumerSlug = slugs.get(e.consumerId);
    return consumerSlug ? [{ ...e, consumerSlug }] : [];
  });
}
