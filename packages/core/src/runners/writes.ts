import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { runners } from '../db/schema.js';

const CHECKOUT_VIEW = {
  id: runners.id,
  projectId: runners.projectId,
  deviceId: runners.deviceId,
  repoPath: runners.repoPath,
  branch: runners.branch,
  status: runners.status,
} as const;

export type RunnerCheckout = {
  repoPath?: string | null | undefined;
  branch?: string | null | undefined;
};

function checkoutSet(patch: RunnerCheckout) {
  return {
    updatedAt: new Date(),
    ...(patch.repoPath !== undefined ? { repoPath: patch.repoPath } : {}),
    ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
  };
}

/**
 * A device binds itself to a project as its runner, or re-binds: the checkout and capabilities
 * sent replace what was stored and provisioning is asked for again.
 */
export async function upsertDeviceRunner(
  tx: Tx,
  args: {
    projectId: string;
    deviceId: string;
    name: string;
    capabilities: Record<string, unknown>;
    capabilitiesSent: Record<string, unknown> | undefined;
    checkout: RunnerCheckout;
    status: 'online' | 'offline';
    now: Date;
  },
) {
  const [row] = await tx
    .insert(runners)
    .values({
      projectId: args.projectId,
      type: 'claude-code',
      deviceId: args.deviceId,
      name: args.name,
      capabilities: args.capabilities,
      ...(args.checkout.repoPath !== undefined ? { repoPath: args.checkout.repoPath } : {}),
      ...(args.checkout.branch !== undefined ? { branch: args.checkout.branch } : {}),
      status: args.status,
      provisionStatus: 'queued',
      provisionRequestedAt: args.now,
    })
    .onConflictDoUpdate({
      target: [runners.projectId, runners.deviceId, runners.type],
      targetWhere: sql`device_id IS NOT NULL`,
      set: {
        updatedAt: args.now,
        ...(args.capabilitiesSent ? { capabilities: args.capabilitiesSent } : {}),
        ...(args.checkout.repoPath !== undefined ? { repoPath: args.checkout.repoPath } : {}),
        ...(args.checkout.branch !== undefined ? { branch: args.checkout.branch } : {}),
        provisionDetail: null,
        provisionRequestedAt: args.now,
      },
    })
    .returning({ ...CHECKOUT_VIEW, labels: runners.labels });
  return row ?? null;
}

/** The device's own runner's checkout; null when the runner is not this device's. */
export async function patchDeviceRunnerCheckout(
  deviceId: string,
  runnerId: string,
  patch: RunnerCheckout,
) {
  const [row] = await db
    .update(runners)
    .set(checkoutSet(patch))
    .where(and(eq(runners.id, runnerId), eq(runners.deviceId, deviceId)))
    .returning(CHECKOUT_VIEW);
  return row ?? null;
}

/** A project admin's edit of a runner's checkout, capabilities and labels; null when not found. */
export async function patchProjectRunner(
  projectId: string,
  runnerId: string,
  patch: RunnerCheckout & {
    capabilities?: Record<string, unknown> | undefined;
    labels?: string[] | undefined;
  },
) {
  const [row] = await db
    .update(runners)
    .set({
      ...checkoutSet(patch),
      ...(patch.capabilities ? { capabilities: patch.capabilities } : {}),
      ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
    })
    .where(and(eq(runners.id, runnerId), eq(runners.projectId, projectId)))
    .returning({ ...CHECKOUT_VIEW, labels: runners.labels });
  return row ?? null;
}

/** Unbind a runner from a project; nothing happens where it is already gone. */
export async function deleteProjectRunner(projectId: string, runnerId: string): Promise<void> {
  await db.delete(runners).where(and(eq(runners.id, runnerId), eq(runners.projectId, projectId)));
}

/** A revoked device's runners go with it. */
export async function deleteDeviceRunners(tx: Tx, deviceIds: readonly string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  await tx.delete(runners).where(inArray(runners.deviceId, [...deviceIds]));
}

/** What provisioning last said about the runners `where` names, and when it was ready. */
export async function setRunnerProvisionDetail(
  tx: Tx,
  where: SQL | undefined,
  detail: string | null,
  ready = false,
) {
  return tx
    .update(runners)
    .set({
      provisionDetail: detail,
      updatedAt: new Date(),
      ...(ready ? { provisionedAt: new Date() } : {}),
    })
    .where(where)
    .returning({
      id: runners.id,
      projectId: runners.projectId,
      deviceId: runners.deviceId,
      provisionStatus: runners.provisionStatus,
    });
}

/**
 * The box's pool reading, one entry per project, stored on each of this device's runners; a runner
 * whose project the reading omits is cleared, in one statement.
 */
export async function storeRunnerPoolReads(
  deviceId: string,
  entries: ReadonlyArray<Record<string, unknown> & { projectId: string }>,
): Promise<void> {
  await db.execute(sql`
    UPDATE runners
    SET pool_read = (
      SELECT e.value FROM jsonb_array_elements(${JSON.stringify(entries)}::jsonb) AS e
      WHERE e.value->>'projectId' = runners.project_id::text
      LIMIT 1
    )
    WHERE device_id = ${deviceId}
  `);
}
