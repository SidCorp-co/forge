import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import {
  contractArtifacts,
  contractMeasurements,
  contractVersions,
} from '../../db/schema-ecosystem.js';
import { storedAs } from '../ecosystem-service.js';
import { type ContractVersionDocument, contractVersionSchema } from './version-schema.js';

export interface StoredVersion {
  providerProjectId: string;
  contractSlug: string;
  version: string;
  contractType: string;
  recordedAt: Date;
  artifactSha256: string | null;
  elements: string[] | null;
  document: ContractVersionDocument;
}

const columns = {
  providerProjectId: contractVersions.providerProjectId,
  contractSlug: contractVersions.contractSlug,
  version: contractVersions.version,
  contractType: contractVersions.contractType,
  recordedAt: contractVersions.recordedAt,
  artifactSha256: contractVersions.artifactSha256,
  elements: contractVersions.elements,
  document: contractVersions.document,
};

const held = (row: Omit<StoredVersion, 'document'> & { document: unknown }): StoredVersion => ({
  ...row,
  document: storedAs(
    contractVersionSchema,
    row.document,
    `contract version ${row.contractSlug}@${row.version} of ${row.providerProjectId}`,
  ),
});

export async function latestVersion(
  tx: Tx,
  providerProjectId: string,
  contractSlug: string,
): Promise<StoredVersion | null> {
  const [row] = await tx
    .select(columns)
    .from(contractVersions)
    .where(
      and(
        eq(contractVersions.providerProjectId, providerProjectId),
        eq(contractVersions.contractSlug, contractSlug),
      ),
    )
    .orderBy(desc(contractVersions.recordedAt))
    .limit(1);
  return row ? held(row) : null;
}

export async function versionsOf(
  tx: Tx,
  providerProjectIds: readonly string[],
  contractSlug?: string,
): Promise<StoredVersion[]> {
  if (providerProjectIds.length === 0) return [];
  const rows = await tx
    .select(columns)
    .from(contractVersions)
    .where(
      and(
        inArray(contractVersions.providerProjectId, [...providerProjectIds]),
        ...(contractSlug ? [eq(contractVersions.contractSlug, contractSlug)] : []),
      ),
    )
    .orderBy(desc(contractVersions.recordedAt));
  return rows.map(held);
}

export async function readArtifact(tx: Tx, sha256: string): Promise<string | null> {
  const [row] = await tx
    .select({ content: contractArtifacts.content })
    .from(contractArtifacts)
    .where(eq(contractArtifacts.sha256, sha256))
    .limit(1);
  return row?.content ?? null;
}

export async function insertVersion(
  tx: Tx,
  input: {
    providerProjectId: string;
    contractSlug: string;
    contractType: string;
    document: ContractVersionDocument;
    artifact: { sha256: string; content: string } | null;
    elements: string[] | null;
  },
): Promise<void> {
  const { artifact, document } = input;
  if (artifact) {
    await tx
      .insert(contractArtifacts)
      .values({
        sha256: artifact.sha256,
        content: artifact.content,
        byteLength: Buffer.byteLength(artifact.content, 'utf8'),
      })
      .onConflictDoNothing();
  }
  await tx.insert(contractVersions).values({
    providerProjectId: input.providerProjectId,
    contractSlug: input.contractSlug,
    version: document.contractVersion,
    recordedAt: new Date(document.observedAt),
    contractType: input.contractType,
    document,
    classification: document.diff.classification,
    artifactSha256: document.artifact?.sha256 ?? null,
    elements: input.elements,
  });
}

export type MeasurementOutcome = 'pending' | 'recorded' | 'unchanged' | 'stale' | 'refused';

export interface MeasurementRow {
  id: string;
  providerProjectId: string;
  contractSlug: string;
  commitSha: string;
  branch: string;
  environments: string[];
  outcome: string;
  version: string | null;
  reason: string | null;
  observedAt: Date;
  settledAt: Date | null;
}

export async function openMeasurements(
  rows: readonly {
    providerProjectId: string;
    contractSlug: string;
    commitSha: string;
    branch: string;
    environments: string[];
  }[],
): Promise<MeasurementRow[]> {
  if (rows.length === 0) return [];
  return db
    .insert(contractMeasurements)
    .values(rows.map((r) => ({ ...r, outcome: 'pending' })))
    .onConflictDoNothing()
    .returning();
}

export async function settleMeasurement(
  id: string,
  outcome: Exclude<MeasurementOutcome, 'pending'>,
  detail: { version?: string; reason?: string },
): Promise<void> {
  await db
    .update(contractMeasurements)
    .set({
      outcome,
      version: detail.version ?? null,
      reason: detail.reason ?? null,
      settledAt: sql`now()`,
    })
    .where(and(eq(contractMeasurements.id, id), eq(contractMeasurements.outcome, 'pending')));
}

export async function readMeasurement(id: string): Promise<MeasurementRow | null> {
  const [row] = await db
    .select()
    .from(contractMeasurements)
    .where(eq(contractMeasurements.id, id))
    .limit(1);
  return row ?? null;
}

export async function measurementsOf(
  providerProjectId: string,
  contractSlug: string,
  limit: number,
): Promise<MeasurementRow[]> {
  return db
    .select()
    .from(contractMeasurements)
    .where(
      and(
        eq(contractMeasurements.providerProjectId, providerProjectId),
        eq(contractMeasurements.contractSlug, contractSlug),
      ),
    )
    .orderBy(desc(contractMeasurements.observedAt))
    .limit(limit);
}
