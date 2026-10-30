// The rows behind a project's environment variables (REQ-80): the variable, its value in the one
// secret store (`project_secrets` under the reserved scope), the proposals agents make and the audit.
// Every write here runs inside the caller's transaction, so a value and the row naming it land
// together or not at all.

import type { VariableEventAct, VariableType } from '@forge/contracts/variables';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { projectSecrets } from '../db/schema-project-config.js';
import {
  projectVariableEvents,
  projectVariableProposals,
  projectVariables,
  VARIABLE_SECRET_SCOPE,
} from '../db/schema-project-variables.js';

export type VariableRow = typeof projectVariables.$inferSelect;
export type ProposalRow = typeof projectVariableProposals.$inferSelect;
export type EventRow = typeof projectVariableEvents.$inferSelect;

/** The name a value is stored under: one per variable or proposal, never reused. */
export const valueNameOf = (kind: 'v' | 'p', id: string) => `${kind}-${id.replaceAll('-', '')}`;

export async function listVariables(projectId: string, tx: Tx = db): Promise<VariableRow[]> {
  return tx
    .select()
    .from(projectVariables)
    .where(eq(projectVariables.projectId, projectId))
    .orderBy(projectVariables.key, projectVariables.environment);
}

export async function variableById(
  tx: Tx,
  projectId: string,
  id: string,
  lock = false,
): Promise<VariableRow | null> {
  const q = tx
    .select()
    .from(projectVariables)
    .where(and(eq(projectVariables.projectId, projectId), eq(projectVariables.id, id)))
    .limit(1);
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
}

export async function variableAt(
  tx: Tx,
  projectId: string,
  key: string,
  environment: string | null,
): Promise<VariableRow | null> {
  const [row] = await tx
    .select()
    .from(projectVariables)
    .where(
      and(
        eq(projectVariables.projectId, projectId),
        eq(projectVariables.key, key),
        environment === null
          ? isNull(projectVariables.environment)
          : eq(projectVariables.environment, environment),
      ),
    )
    .limit(1)
    .for('update');
  return row ?? null;
}

export async function keysHeld(projectId: string, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .select({ key: projectVariables.key })
    .from(projectVariables)
    .where(
      and(eq(projectVariables.projectId, projectId), inArray(projectVariables.key, [...keys])),
    );
  return new Set(rows.map((r) => r.key));
}

/** Write a value into the one store, replacing what the name held. */
export async function putValue(tx: Tx, projectId: string, name: string, valueEnc: Buffer) {
  const now = new Date();
  await tx
    .insert(projectSecrets)
    .values({ projectId, scope: VARIABLE_SECRET_SCOPE, name, valueEnc, updatedAt: now })
    .onConflictDoUpdate({
      target: [projectSecrets.projectId, projectSecrets.scope, projectSecrets.name],
      set: { valueEnc, updatedAt: now },
    });
}

export async function dropValue(tx: Tx, projectId: string, name: string): Promise<void> {
  await tx
    .delete(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.scope, VARIABLE_SECRET_SCOPE),
        eq(projectSecrets.name, name),
      ),
    );
}

/** The encrypted values stored under these names. */
export async function valuesOf(
  projectId: string,
  names: readonly string[],
  tx: Tx = db,
): Promise<Map<string, Buffer>> {
  if (names.length === 0) return new Map();
  const rows = await tx
    .select({ name: projectSecrets.name, valueEnc: projectSecrets.valueEnc })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.scope, VARIABLE_SECRET_SCOPE),
        inArray(projectSecrets.name, [...names]),
      ),
    );
  return new Map(rows.map((r) => [r.name, r.valueEnc]));
}

export async function insertVariable(
  tx: Tx,
  row: {
    id: string;
    projectId: string;
    key: string;
    environment: string | null;
    type: VariableType;
    protected: boolean;
    fingerprint: string;
    userId: string | null;
  },
): Promise<VariableRow> {
  const [inserted] = await tx
    .insert(projectVariables)
    .values({
      id: row.id,
      projectId: row.projectId,
      key: row.key,
      environment: row.environment,
      type: row.type,
      protected: row.protected,
      secretName: valueNameOf('v', row.id),
      fingerprint: row.fingerprint,
      createdBy: row.userId,
      updatedBy: row.userId,
    })
    .returning();
  if (!inserted) throw new Error('variables: the insert returned no row');
  return inserted;
}

export async function updateVariable(
  tx: Tx,
  id: string,
  set: {
    type: VariableType;
    protected: boolean;
    fingerprint: string;
    version: number;
    userId: string | null;
  },
): Promise<VariableRow> {
  const [updated] = await tx
    .update(projectVariables)
    .set({
      type: set.type,
      protected: set.protected,
      fingerprint: set.fingerprint,
      version: set.version,
      updatedBy: set.userId,
      updatedAt: new Date(),
    })
    .where(eq(projectVariables.id, id))
    .returning();
  if (!updated) throw new Error(`variables: variable ${id} vanished inside its own update`);
  return updated;
}

export async function deleteVariable(tx: Tx, row: VariableRow): Promise<void> {
  await tx.delete(projectVariables).where(eq(projectVariables.id, row.id));
  await dropValue(tx, row.projectId, row.secretName);
}

export interface EventInput {
  projectId: string;
  variableId: string | null;
  act: VariableEventAct;
  key: string;
  environment: string | null;
  actorId: string | null;
  actorTokenId: string | null;
  agency: 'human' | 'agent' | null;
  oldFingerprint?: string | null;
  newFingerprint?: string | null;
  detail?: Record<string, unknown>;
}

export async function insertEvents(tx: Tx, events: readonly EventInput[]): Promise<void> {
  if (events.length === 0) return;
  await tx.insert(projectVariableEvents).values(
    events.map((e) => ({
      projectId: e.projectId,
      variableId: e.variableId,
      act: e.act,
      key: e.key,
      environment: e.environment,
      actorId: e.actorId,
      actorTokenId: e.actorTokenId,
      agency: e.agency,
      oldFingerprint: e.oldFingerprint ?? null,
      newFingerprint: e.newFingerprint ?? null,
      detail: e.detail ?? {},
    })),
  );
}

export async function listEvents(projectId: string, limit: number): Promise<EventRow[]> {
  return db
    .select()
    .from(projectVariableEvents)
    .where(eq(projectVariableEvents.projectId, projectId))
    .orderBy(desc(projectVariableEvents.at), desc(projectVariableEvents.id))
    .limit(limit);
}

export async function insertProposal(
  tx: Tx,
  row: Omit<typeof projectVariableProposals.$inferInsert, 'status'>,
): Promise<ProposalRow> {
  const [inserted] = await tx.insert(projectVariableProposals).values(row).returning();
  if (!inserted) throw new Error('variables: the proposal insert returned no row');
  return inserted;
}

export async function proposalById(
  tx: Tx,
  projectId: string,
  id: string,
): Promise<ProposalRow | null> {
  const [row] = await tx
    .select()
    .from(projectVariableProposals)
    .where(
      and(eq(projectVariableProposals.projectId, projectId), eq(projectVariableProposals.id, id)),
    )
    .limit(1)
    .for('update');
  return row ?? null;
}

export async function listProposals(projectId: string): Promise<ProposalRow[]> {
  return db
    .select()
    .from(projectVariableProposals)
    .where(eq(projectVariableProposals.projectId, projectId))
    .orderBy(desc(projectVariableProposals.createdAt));
}

export async function closeProposal(
  tx: Tx,
  id: string,
  set: { status: 'approved' | 'rejected'; decidedBy: string | null; reason: string },
): Promise<ProposalRow> {
  const [row] = await tx
    .update(projectVariableProposals)
    .set({
      status: set.status,
      decidedBy: set.decidedBy,
      decisionReason: set.reason,
      decidedAt: new Date(),
      secretName: null,
    })
    .where(eq(projectVariableProposals.id, id))
    .returning();
  if (!row) throw new Error(`variables: proposal ${id} vanished inside its own decision`);
  return row;
}
