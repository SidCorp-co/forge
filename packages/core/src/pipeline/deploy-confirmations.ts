import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';

export const DEPLOY_CONFIRM_METADATA_KEY = '__forge_deploy_confirm';
export const DEPLOY_CLOSE_PENDING_METADATA_KEY = '__forge_deploy_close_pending';

export const DEPLOY_CONFIRM_WINDOW_MS = 30 * 60_000;

export type DeployConfirmationStatus = 'pending' | 'succeeded' | 'failed';

export interface DeployConfirmation {
  bindingId: string;
  /** `null` while the dispatch is enqueued and Coolify has not named a deployment yet. */
  deploymentUuid: string | null;
  targetLabel: string;
  status: DeployConfirmationStatus;
  deadlineAt: string;
  detail?: string;
}

export type DeployHolds = Record<string, DeployConfirmation>;

/** Key for the placeholder a dispatcher opens before the targets are known. */
export const dispatchHoldKey = (requestId: string): string => `dispatch:${requestId}`;
/** Key for a real per-target hold, once Coolify has named the deployment. */
export const targetHoldKey = (deliveryId: string): string => `target:${deliveryId}`;

const holdsParentEnsured = sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object('__forge_deploy_confirm', coalesce(${pipelineRuns.metadata} -> '__forge_deploy_confirm', '{}'::jsonb))`;

async function writeHold(
  runId: string,
  key: string,
  hold: DeployConfirmation,
  /** Whether a terminal run may still take this write (ISS-1279). Only a write about a deploy
   *  Coolify already accepted passes it: a target failing closes the run while its siblings keep
   *  building, and refusing THEIR record leaves it saying a finished deploy is still pending. */
  evenIfTerminal = false,
): Promise<boolean> {
  const live = inArray(pipelineRuns.status, ['running', 'paused']);
  const written = await db
    .update(pipelineRuns)
    .set({
      metadata: sql`jsonb_set(${holdsParentEnsured}, ARRAY['__forge_deploy_confirm', ${key}], ${JSON.stringify(hold)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(evenIfTerminal ? eq(pipelineRuns.id, runId) : and(eq(pipelineRuns.id, runId), live))
    .returning({ id: pipelineRuns.id });
  return written.length > 0;
}

/** Forget a placeholder whose deploy was never queued (ISS-1279): nothing can settle it, so the run cannot close and the environment stays held to that hold's own deadline. */
export async function abandonDeployDispatchHold(runId: string, requestId: string): Promise<void> {
  await dropHold(runId, dispatchHoldKey(requestId));
}

async function dropHold(runId: string, key: string): Promise<void> {
  await db
    .update(pipelineRuns)
    .set({
      metadata: sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) #- ARRAY['__forge_deploy_confirm', ${key}]`,
      updatedAt: new Date(),
    })
    .where(eq(pipelineRuns.id, runId));
}

export async function readDeployHolds(runId: string): Promise<DeployHolds> {
  const [row] = await db
    .select({ metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  const md = (row?.metadata ?? {}) as Record<string, unknown>;
  return (md[DEPLOY_CONFIRM_METADATA_KEY] as DeployHolds | undefined) ?? {};
}

/**
 * Open the placeholder hold at ENQUEUE time, before the deploy job runs. The
 * window between enqueueing a deploy and the adapter learning its
 * `deployment_uuid` is a window in which the run could otherwise close
 * `completed` with nothing recorded against it.
 *
 * @returns `false` when the run was already terminal and refused the hold — the
 * deploy will still run, but no run can witness its outcome.
 */
export async function openDeployDispatchHold(args: {
  runId: string;
  bindingId: string;
  requestId: string;
  targetLabel: string;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  return writeHold(args.runId, dispatchHoldKey(args.requestId), {
    bindingId: args.bindingId,
    deploymentUuid: null,
    targetLabel: args.targetLabel,
    status: 'pending',
    deadlineAt: new Date(now.getTime() + DEPLOY_CONFIRM_WINDOW_MS).toISOString(),
  });
}

/**
 * Replace one dispatch placeholder with the real per-target holds. Called once
 * the adapter has fanned out and every target has a `deployment_uuid` (or has
 * failed to get one, which is already a resolved hold).
 *
 * @returns `false` when the run refused any hold — it went terminal while the
 * deploy was being dispatched, so nothing can witness this deploy's outcome.
 */
export async function replaceDispatchHoldWithTargets(args: {
  runId: string;
  requestId?: string;
  bindingId: string;
  targets: {
    deliveryId: string;
    targetLabel: string;
    deploymentUuid: string | null;
    status: DeployConfirmationStatus;
    detail?: string;
  }[];
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  const deadlineAt = new Date(now.getTime() + DEPLOY_CONFIRM_WINDOW_MS).toISOString();
  // A terminal run records the outcome of work it authorised while live and takes on nothing new: a standing placeholder IS that authorisation (ISS-1279), and its absence leaves ISS-922's rule where it was.
  const placeholder = args.requestId ? dispatchHoldKey(args.requestId) : null;
  const replacing = placeholder !== null && placeholder in (await readDeployHolds(args.runId));
  let allHeld = true;
  for (const t of args.targets) {
    const held = await writeHold(
      args.runId,
      targetHoldKey(t.deliveryId),
      {
        bindingId: args.bindingId,
        deploymentUuid: t.deploymentUuid,
        targetLabel: t.targetLabel,
        status: t.status,
        deadlineAt,
        ...(t.detail ? { detail: t.detail } : {}),
      },
      replacing,
    );
    if (!held) allHeld = false;
  }
  // Only once every target stands in its place: dropped beside a refused write it leaves a run with no holds at all, which every reader takes for a deploy that finished.
  if (placeholder && allHeld) await dropHold(args.runId, placeholder);
  return allHeld;
}

/** Record what Coolify said about one deploy target. */
export async function settleDeployTarget(args: {
  runId: string;
  deliveryId: string;
  status: Exclude<DeployConfirmationStatus, 'pending'>;
  detail?: string;
}): Promise<DeployHolds> {
  const key = targetHoldKey(args.deliveryId);
  const holds = await readDeployHolds(args.runId);
  const existing = holds[key];
  if (existing) {
    await writeHold(
      args.runId,
      key,
      { ...existing, status: args.status, ...(args.detail ? { detail: args.detail } : {}) },
      true,
    );
  }
  return readDeployHolds(args.runId);
}

export type DeployGateVerdict =
  | { verdict: 'clear' }
  | { verdict: 'defer'; confirmed: number; total: number }
  | { verdict: 'failed'; detail: string };

export function resolveDeployGate(holds: DeployHolds, now: Date = new Date()): DeployGateVerdict {
  const entries = Object.values(holds);
  if (entries.length === 0) return { verdict: 'clear' };

  const failed = entries.filter((h) => h.status === 'failed');
  if (failed.length > 0) {
    const detail = failed
      .map((h) => `${h.targetLabel}${h.detail ? `: ${h.detail}` : ''}`)
      .join('; ');
    return { verdict: 'failed', detail };
  }

  const pending = entries.filter((h) => h.status === 'pending');
  if (pending.length === 0) return { verdict: 'clear' };

  const expired = pending.filter((h) => new Date(h.deadlineAt).getTime() <= now.getTime());
  if (expired.length > 0) {
    const detail = expired
      .map((h) => `${h.targetLabel} (${h.deploymentUuid ?? 'no deployment_uuid'}) unconfirmed`)
      .join('; ');
    return { verdict: 'failed', detail };
  }

  return {
    verdict: 'defer',
    confirmed: entries.length - pending.length,
    total: entries.length,
  };
}

/**
 * Remember that a caller wanted to close this run and was deferred, so the
 * confirmation that resolves the last hold performs the close the caller could
 * not. Without this the deferral would simply lose the close until a sweeper
 * re-found the run.
 */
export async function markCloseDeferred(runId: string): Promise<void> {
  await db
    .update(pipelineRuns)
    .set({
      metadata: sql`jsonb_set(coalesce(${pipelineRuns.metadata}, '{}'::jsonb), ARRAY[${DEPLOY_CLOSE_PENDING_METADATA_KEY}], 'true'::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])));
}

export async function isCloseDeferred(runId: string): Promise<boolean> {
  const [row] = await db
    .select({ metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  const md = (row?.metadata ?? {}) as Record<string, unknown>;
  return md[DEPLOY_CLOSE_PENDING_METADATA_KEY] === true;
}
