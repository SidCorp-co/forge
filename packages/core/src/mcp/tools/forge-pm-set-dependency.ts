/**
 * `forge_pm.set_dependency` (Epic 3, ISS-19) — record a dependency edge
 * between two issues in the same project. Idempotent on the unique edge
 * `(project_id, from_issue_id, to_issue_id, kind)` from Epic 1; a duplicate
 * returns `created: false` and applies whichever of `validUntil` / `reason`
 * the caller supplied, reporting that as `updated`. Setting `validUntil` into
 * the past is how an edge is RETRACTED — the only agent-reachable way, since
 * the DELETE route is JWT-only REST.
 *
 * Epic 4 (ISS-20) wires the `dependencyChanged` hook emit on first insert so
 * PM spawn triggers react to graph mutations.
 *
 * ISS-145: handler body extracted into `pmSetDependencyHandler` and
 * consumed by both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 *
 * TODO ISS-145-followup: remove the legacy shim factory after the
 * deprecation window closes.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { type Db, db } from '../../db/client.js';
import { issueDependencies, issueDependencyKinds, issues } from '../../db/schema.js';
import {
  finalizeDecomposition,
  type PendingDecomposition,
  prepareDecomposition,
} from '../../issues/decompose.js';
import { detectCycle } from '../../issues/dependency-routes.js';
import { publishPipelineHealthChanged } from '../../issues/pipeline-health.js';
import { type Actor, safeRecordActivity } from '../../pipeline/activity.js';
import { hooks } from '../../pipeline/hooks.js';
import { deprecationFor } from '../deprecation.js';
import {
  assertDeviceOwnerIsMember,
  type ContextScopedMcpToolFactory,
  type McpContext,
  zodToMcpSchema,
} from './lib.js';

export const pmSetDependencyInputSchema = z
  .object({
    projectId: z.uuid(),
    fromIssueId: z.uuid(),
    toIssueId: z.uuid(),
    kind: z.enum(issueDependencyKinds),
    reason: z.string().trim().min(1).max(2000).optional(),
    validUntil: z.iso.datetime().optional(),
    // ISS-138 (PR-D) — opt-in to/out of integration-branch auto-creation
    // when `kind === 'decomposes'`. Ignored for other kinds.
    decomposeOpts: z.object({ useIntegrationBranch: z.boolean().optional() }).strict().optional(),
  })
  .strict();

type DependencyExecutor = Pick<Db, 'execute' | 'select' | 'insert' | 'update'>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DependencyInput = z.infer<typeof pmSetDependencyInputSchema>;
type DependencyEffect = {
  action: 'added' | 'updated';
  edgeId: string;
  fromIssueId: string;
  toIssueId: string;
  kind: DependencyInput['kind'];
  validUntil?: string;
  reason?: string;
};

function isActiveDependency(validUntil: Date | null): boolean {
  return validUntil === null || validUntil > new Date();
}

export type DependencyMutation = {
  id: string;
  created: boolean;
  updated: boolean;
  active: boolean;
  effect: DependencyEffect | null;
};

export async function mutateDependency(
  executor: DependencyExecutor,
  input: DependencyInput,
  createdById: string,
): Promise<DependencyMutation> {
  if (input.fromIssueId === input.toIssueId) {
    throw new Error('BAD_REQUEST: self-edge not allowed');
  }

  if (input.kind === 'blocks') {
    // cm:guard serialize `blocks` mutations per project — concurrent cycle checks on opposite edges both see an acyclic snapshot, so without this transaction lock they can commit a dispatch-deadlocking cycle
    await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.projectId}))`);
  }

  const sides = await executor
    .select({ id: issues.id, projectId: issues.projectId, status: issues.status })
    .from(issues)
    .where(inArray(issues.id, [input.fromIssueId, input.toIssueId]));
  if (sides.length !== 2) {
    throw new Error('NOT_FOUND: one or both issues not found');
  }
  for (const s of sides) {
    if (s.projectId !== input.projectId) {
      throw new Error('BAD_REQUEST: both issues must belong to projectId');
    }
  }
  let [existing] = await executor
    .select({ id: issueDependencies.id, validUntil: issueDependencies.validUntil })
    .from(issueDependencies)
    .where(
      and(
        eq(issueDependencies.projectId, input.projectId),
        eq(issueDependencies.fromIssueId, input.fromIssueId),
        eq(issueDependencies.toIssueId, input.toIssueId),
        eq(issueDependencies.kind, input.kind),
      ),
    )
    .limit(1);
  const finalValidUntil =
    input.validUntil === undefined ? (existing?.validUntil ?? null) : new Date(input.validUntil);
  const requestedActive = isActiveDependency(finalValidUntil);
  const fromIssue = sides.find((side) => side.id === input.fromIssueId);
  if (input.kind === 'blocks' && requestedActive && fromIssue?.status === 'dropped') {
    throw new Error('BAD_REQUEST: a dropped issue cannot block another issue');
  }

  if (input.kind === 'blocks' && requestedActive) {
    const cycle = await detectCycle(input.projectId, input.toIssueId, input.fromIssueId, executor);
    if (cycle === 'cycle') {
      throw new Error('CYCLE_DETECTED: adding this blocks edge would form a loop');
    }
    if (cycle === 'depth_exceeded') {
      throw new Error('CYCLE_DEPTH_EXCEEDED: dependency graph exceeds detection depth');
    }
  }

  if (!existing) {
    const inserted = await executor
      .insert(issueDependencies)
      .values({
        projectId: input.projectId,
        fromIssueId: input.fromIssueId,
        toIssueId: input.toIssueId,
        kind: input.kind,
        reason: input.reason ?? null,
        createdById,
        validUntil: finalValidUntil,
      })
      .onConflictDoNothing({
        target: [
          issueDependencies.projectId,
          issueDependencies.fromIssueId,
          issueDependencies.toIssueId,
          issueDependencies.kind,
        ],
      })
      .returning({ id: issueDependencies.id });

    const id = inserted[0]?.id;
    if (id) {
      return {
        id,
        created: true,
        updated: false,
        active: requestedActive,
        effect: {
          action: 'added',
          edgeId: id,
          fromIssueId: input.fromIssueId,
          toIssueId: input.toIssueId,
          kind: input.kind,
          ...(input.validUntil ? { validUntil: input.validUntil } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      };
    }

    [existing] = await executor
      .select({ id: issueDependencies.id, validUntil: issueDependencies.validUntil })
      .from(issueDependencies)
      .where(
        and(
          eq(issueDependencies.projectId, input.projectId),
          eq(issueDependencies.fromIssueId, input.fromIssueId),
          eq(issueDependencies.toIssueId, input.toIssueId),
          eq(issueDependencies.kind, input.kind),
        ),
      )
      .limit(1);
  }
  if (!existing) {
    throw new Error('forge_pm.set_dependency: conflict but no existing row found');
  }

  // cm:guard apply `validUntil`/`reason` on the CONFLICT path too — the tool advertises both and the `onConflictDoNothing` above silently dropped them, which left a `blocks` edge retractable by no agent-reachable API at all (the DELETE route is JWT-only REST). It matters because a `dropped` blocker never stamps `merged_at`: on getcontent a consolidation dropped ISS-463 and its stale edge held ISS-455, and via ISS-455 held ISS-457, queued for 53h with nobody notified (measured 2026-08-22).
  // cm:why only the fields the caller actually sent — a bare re-assert of an existing edge is the common idempotent call, and blanking someone's expiry or reason because they omitted it is a silent data loss
  const patch: { validUntil?: Date; reason?: string } = {};
  if (input.validUntil) patch.validUntil = new Date(input.validUntil);
  if (input.reason) patch.reason = input.reason;
  const updated = Object.keys(patch).length > 0;

  if (!updated) {
    return {
      id: existing.id,
      created: false,
      updated: false,
      active: isActiveDependency(existing.validUntil),
      effect: null,
    };
  }

  await executor.update(issueDependencies).set(patch).where(eq(issueDependencies.id, existing.id));
  return {
    id: existing.id,
    created: false,
    updated: true,
    active: isActiveDependency(patch.validUntil ?? existing.validUntil),
    effect: {
      action: 'updated',
      edgeId: existing.id,
      fromIssueId: input.fromIssueId,
      toIssueId: input.toIssueId,
      kind: input.kind,
      ...(input.validUntil ? { validUntil: input.validUntil } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
}

export async function finalizeDependencyMutation(
  mutation: DependencyMutation,
  input: DependencyInput,
  actor: Actor,
): Promise<void> {
  if (!mutation.effect) return;
  const effect = mutation.effect;
  // cm:guard emit `dependencyChanged` after the transaction commits — expiring an edge can make the gated side dispatchable THIS INSTANT, and a hook that runs before commit can dispatch against the old graph or publish an effect from a rolled-back relation batch
  await hooks.emit('dependencyChanged', {
    projectId: input.projectId,
    edgeId: effect.edgeId,
    fromIssueId: effect.fromIssueId,
    toIssueId: effect.toIssueId,
    kind: effect.kind,
  });
  await Promise.all([
    safeRecordActivity({
      issueId: effect.fromIssueId,
      actor,
      action: `issue.dependency.${effect.action}`,
      payload: {
        edgeId: effect.edgeId,
        fromIssueId: effect.fromIssueId,
        toIssueId: effect.toIssueId,
        kind: effect.kind,
        ...(effect.validUntil ? { validUntil: effect.validUntil } : {}),
        ...(effect.reason ? { reason: effect.reason } : {}),
      },
    }),
    safeRecordActivity({
      issueId: effect.toIssueId,
      actor,
      action: `issue.dependency.${effect.action}`,
      payload: {
        edgeId: effect.edgeId,
        fromIssueId: effect.fromIssueId,
        toIssueId: effect.toIssueId,
        kind: effect.kind,
        ...(effect.validUntil ? { validUntil: effect.validUntil } : {}),
        ...(effect.reason ? { reason: effect.reason } : {}),
      },
    }),
  ]);
  if (effect.kind === 'blocks' || effect.kind === 'decomposes') {
    // cm:guard publish decompose health for its `from` parent — only the parent derives decomposeChildrenPending, while blocks gates `to`; selecting the child leaves a waiting parent stale
    const healthIssueId = effect.kind === 'decomposes' ? effect.fromIssueId : effect.toIssueId;
    await publishPipelineHealthChanged(input.projectId, [healthIssueId]);
  }
}

// cm:guard pass `actor` whenever the caller knows its principal — a PAT reaches here behind a SYNTHETIC device (mcp/handler.ts stubDeviceForPat) whose id is an api_tokens row, so the default writes an activity_log actor_id that matches no `devices` row while the same request's status transition is attributed correctly through principalActor()
export async function pmSetDependencyHandler(
  device: Device,
  input: DependencyInput,
  actorOverride?: Actor,
) {
  // ISS-131 — was `assertPmActor`. Plan-pipeline agents legitimately need to
  // declare `blocks`/`decomposes` edges as part of writing a plan, but they
  // run on `claude-code` runners that do not carry the PM capability flag.
  // The cycle guard below + the unique-index idempotency already cover the
  // abuse surface; gate on plain project membership instead.
  await assertDeviceOwnerIsMember(device, input.projectId);
  let pendingDecomposition: PendingDecomposition | null = null;
  const mutation = await db.transaction(async (tx) => {
    const mutation = await mutateDependency(tx, input, device.ownerId);
    // cm:guard prepare decomposition in the relation transaction — a branch or review-gate failure must roll back the edge that requested it, otherwise a successful edge response lies about integration state and a competing retry can make cleanup delete a valid edge
    if (mutation.active) {
      pendingDecomposition = await prepareDecompositionMutation(tx, input, device.ownerId);
    }
    return mutation;
  });
  if (pendingDecomposition) await finalizeDecomposition(pendingDecomposition);
  const actor = actorOverride ?? { type: 'device' as const, id: device.id };
  await finalizeDependencyMutation(mutation, input, actor);
  return {
    id: mutation.id,
    created: mutation.created,
    updated: mutation.updated,
  };
}

async function prepareDecompositionMutation(
  tx: Tx,
  input: DependencyInput,
  ownerId: string,
): Promise<PendingDecomposition | null> {
  if (input.kind !== 'decomposes') return null;
  return prepareDecomposition(
    tx,
    input.fromIssueId,
    [{ existingIssueId: input.toIssueId }],
    { userId: ownerId },
    { useIntegrationBranch: input.decomposeOpts?.useIntegrationBranch },
  );
}

function recordDeprecation(ctx: McpContext, toolName: string) {
  if (deprecationFor(toolName) && ctx.deprecations) ctx.deprecations.add(toolName);
}

export const forgePmSetDependencyTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pm.set_dependency',
  description:
    "[DEPRECATED — use forge_project_pm (action=set_dependency)] Requires a paired-device token: a personal access token is refused with PM_REQUIRES_DEVICE, and its blocks/relates path is forge_issues create/update data.relations instead. Record a dependency edge (blocks/relates/duplicates/parent/decomposes) between two issues in the same project. Idempotent on (projectId, fromIssueId, toIssueId, kind) — a duplicate call returns created:false and applies whichever of `validUntil`/`reason` you passed, reporting `updated:true` when it changed something. Expire an edge by setting `validUntil` in the past; that is the only way an agent can retract one (DELETE is JWT-only REST). Omitted fields are left alone. Caller must be a member of the project. Dispatcher convention (ISS-40 PR-E): only `kind='blocks'` rows gate dispatch — `(from=A, to=B, kind='blocks')` means B waits for A's `merged_at` stamp; a reopened A blocks again, and a closed A without that stamp unblocks B only on a structurally unstampable base. For `blocks` edges, cycles are rejected with a CYCLE_DETECTED error. ISS-138 (PR-D): when `kind='decomposes'`, the first edge added to a parent also triggers integration-branch creation + branchConfig auto-fill on parent and child. Pass `decomposeOpts.useIntegrationBranch: false` to opt out (children then branch off the project default).",
  inputSchema: zodToMcpSchema(pmSetDependencyInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pm.set_dependency');
    const input = pmSetDependencyInputSchema.parse(args);
    return pmSetDependencyHandler(ctx.device, input);
  },
});
