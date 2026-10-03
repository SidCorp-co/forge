import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import {
  contractArtifacts,
  contractMeasurements,
  contractVersions,
} from '../../db/schema-ecosystem.js';
import { storedAs } from '../ecosystem-service.js';
import type { ContractApproval, DecidedAs } from './approval.js';
import { type ContractVersionDocument, contractVersionSchema } from './version-schema.js';

export interface StoredVersion {
  providerProjectId: string;
  contractSlug: string;
  version: string;
  contractType: string;
  recordedAt: Date;
  artifactSha256: string | null;
  elements: string[] | null;
  approval: ContractApproval;
  decidedBy: string | null;
  decidedAs: DecidedAs | null;
  decidedAt: Date | null;
  decisionReason: string | null;
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
  approval: contractVersions.approval,
  decidedBy: contractVersions.decidedBy,
  decidedAs: contractVersions.decidedAs,
  decidedAt: contractVersions.decidedAt,
  decisionReason: contractVersions.decisionReason,
  document: contractVersions.document,
};

type Row = Omit<StoredVersion, 'document' | 'approval' | 'decidedAs'> & {
  document: unknown;
  approval: string;
  decidedAs: string | null;
};

const held = (row: Row): StoredVersion => ({
  ...row,
  approval: row.approval as ContractApproval,
  decidedAs: row.decidedAs as DecidedAs | null,
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

/** Where a version stands in the approval gate, as every read shows it. */
export const approvalView = (v: StoredVersion) => ({
  state: v.approval,
  decidedBy: v.decidedBy,
  decidedAs: v.decidedAs,
  decidedAt: v.decidedAt?.toISOString() ?? null,
  reason: v.decisionReason,
});

/** The newest approved version of a contract: the one that is current. A proposed or returned version never is. */
export async function currentVersion(
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
        eq(contractVersions.approval, 'approved'),
      ),
    )
    .orderBy(desc(contractVersions.recordedAt))
    .limit(1);
  return row ? held(row) : null;
}

/** The current version from a newest-first list `versionsOf` read: the first approved one. */
export const currentOf = (versions: readonly StoredVersion[]): StoredVersion | null =>
  versions.find((v) => v.approval === 'approved') ?? null;

/** Writes a decision on a version that is still proposed; false where another decision got there first. */
export async function decideVersion(
  tx: Tx,
  input: {
    providerProjectId: string;
    contractSlug: string;
    version: string;
    approval: Exclude<ContractApproval, 'proposed'>;
    decidedBy: string;
    decidedAs: Exclude<DecidedAs, 'before-approval'>;
    reason: string | null;
  },
): Promise<boolean> {
  const rows = await tx
    .update(contractVersions)
    .set({
      approval: input.approval,
      decidedBy: input.decidedBy,
      decidedAs: input.decidedAs,
      decidedAt: sql`now()`,
      decisionReason: input.reason,
    })
    .where(
      and(
        eq(contractVersions.providerProjectId, input.providerProjectId),
        eq(contractVersions.contractSlug, input.contractSlug),
        eq(contractVersions.version, input.version),
        eq(contractVersions.approval, 'proposed'),
      ),
    )
    .returning({ version: contractVersions.version });
  return rows.length === 1;
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
