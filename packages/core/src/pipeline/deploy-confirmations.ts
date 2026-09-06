/**
 * ISS-922 — the evidence a run needs before it may claim `completed`.
 *
 * A deploy dispatch writes one CONFIRMATION HOLD per deploy target onto
 * `pipeline_runs.metadata`. Until every hold reports back from Coolify, the
 * run's terminal status is not the dispatcher's to write: `closeRun` and its
 * two siblings ask {@link resolveDeployGate} first, and a run with an
 * unresolved hold stays `running` at `release.deploy.in_flight` — which is
 * true — instead of closing `completed` on the evidence that somebody asked
 * for a deploy.
 *
 * Measured on the fleet 2026-09-06, before this module existed: 5,408 outbound
 * deliveries and 0 inbound ever, `release.deploy.done` stamped 0 times, and 50
 * runs sitting at `status='completed'` while their own `current_step` still
 * read `release.deploy.in_flight`.
 *
 * Every hold carries its own `deadlineAt`, so the gate is bounded by
 * construction: past the deadline an unconfirmed deploy resolves `failed`
 * rather than waiting, and no run can leak on this axis.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';

export const DEPLOY_CONFIRM_METADATA_KEY = '__forge_deploy_confirm';
export const DEPLOY_CLOSE_PENDING_METADATA_KEY = '__forge_deploy_close_pending';

// cm:why 30 minutes, against the 60 of `RESULT_QUIET_MINUTES`: the gate must always resolve BEFORE the sweeper's own quiet window opens, or two mechanisms decide one run's outcome. The price is a false `failed` on a build slower than 30 minutes, and it ends when a project can declare its own deadline.
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

// cm:guard `jsonb_set(..., create_missing => true)` creates only the LAST path element — with the holds map absent, a two-element path writes NOTHING and returns success. Verified against Postgres 16, 2026-09-06: `jsonb_set('{}', ARRAY['a','b'], '1', true)` is `{}`. So the parent map is materialised first, in the same expression.
const holdsParentEnsured = sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object('__forge_deploy_confirm', coalesce(${pipelineRuns.metadata} -> '__forge_deploy_confirm', '{}'::jsonb))`;

// cm:guard every write here is a single `jsonb_set` on ONE key, never a read-modify-write of the whole map — two targets of the same binding settle concurrently and a whole-map write loses one of them silently, which is the exact failure this module exists to make impossible.
// cm:guard the `status IN ('running','paused')` predicate is what makes a hold un-writable on a terminal run. A run that closed before its deploy was asked for cannot prove that deploy, and stamping it anyway is how `completed` came to wear `release.deploy.in_flight`.
async function writeHold(runId: string, key: string, hold: DeployConfirmation): Promise<boolean> {
  const written = await db
    .update(pipelineRuns)
    .set({
      metadata: sql`jsonb_set(${holdsParentEnsured}, ARRAY['__forge_deploy_confirm', ${key}], ${JSON.stringify(hold)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])))
    .returning({ id: pipelineRuns.id });
  return written.length > 0;
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
// cm:guard the target holds are written whether or not a placeholder exists, and `requestId` is optional for exactly that reason: a dispatch with no requestId has no placeholder to replace, and gating the WRITE on one would leave its run with no holds at all — which `resolveDeployGate` reads as `clear`, i.e. the original defect.
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
  let allHeld = true;
  for (const t of args.targets) {
    const held = await writeHold(args.runId, targetHoldKey(t.deliveryId), {
      bindingId: args.bindingId,
      deploymentUuid: t.deploymentUuid,
      targetLabel: t.targetLabel,
      status: t.status,
      deadlineAt,
      ...(t.detail ? { detail: t.detail } : {}),
    });
    if (!held) allHeld = false;
  }
  if (args.requestId) await dropHold(args.runId, dispatchHoldKey(args.requestId));
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
    await writeHold(args.runId, key, {
      ...existing,
      status: args.status,
      ...(args.detail ? { detail: args.detail } : {}),
    });
  }
  return readDeployHolds(args.runId);
}

export type DeployGateVerdict =
  | { verdict: 'clear' }
  | { verdict: 'defer'; confirmed: number; total: number }
  | { verdict: 'failed'; detail: string };

/**
 * What the holds permit a caller that wants to write `completed`.
 *
 * `clear` — no deploy was dispatched for this run, or every target confirmed.
 * `defer` — a deploy is genuinely still in flight; nobody may call the run yet.
 * `failed` — Coolify reported a failure, or a deploy went unconfirmed past its
 * deadline. Both are the run's outcome, not an annotation on it.
 */
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
