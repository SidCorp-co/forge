/**
 * `forge_pm.set_dependency` (Epic 3, ISS-19) — record a dependency edge
 * between two issues in the same project. Idempotent on the unique edge
 * `(project_id, from_issue_id, to_issue_id, kind)` from Epic 1; duplicates
 * return the existing row with `created: false`.
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

import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { db } from '../../db/client.js';
import { issueDependencies, issueDependencyKinds, issues } from '../../db/schema.js';
import { decomposeParent } from '../../issues/decompose.js';
import { detectCycle } from '../../issues/dependency-routes.js';
import { publishPipelineHealthChanged } from '../../issues/pipeline-health.js';
import { logger } from '../../logger.js';
import { safeRecordActivity } from '../../pipeline/activity.js';
import { hooks } from '../../pipeline/hooks.js';
import { deprecationFor } from '../deprecation.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  assertDeviceOwnerIsMember,
  zodToMcpSchema,
} from './lib.js';

export const pmSetDependencyInputSchema = z
  .object({
    projectId: z.uuid(),
    fromIssueId: z.uuid(),
    toIssueId: z.uuid(),
    kind: z.enum(issueDependencyKinds),
    reason: z.string().max(2000).optional(),
    validUntil: z.iso.datetime().optional(),
    // ISS-138 (PR-D) — opt-in to/out of integration-branch auto-creation
    // when `kind === 'decomposes'`. Ignored for other kinds.
    decomposeOpts: z
      .object({ useIntegrationBranch: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();

export async function pmSetDependencyHandler(
  device: Device,
  input: z.infer<typeof pmSetDependencyInputSchema>,
) {
  // ISS-131 — was `assertPmActor`. Plan-pipeline agents legitimately need to
  // declare `blocks`/`decomposes` edges as part of writing a plan, but they
  // run on `claude-code` runners that do not carry the PM capability flag.
  // The cycle guard below + the unique-index idempotency already cover the
  // abuse surface; gate on plain project membership instead.
  await assertDeviceOwnerIsMember(device, input.projectId);

  if (input.fromIssueId === input.toIssueId) {
    throw new Error('BAD_REQUEST: self-edge not allowed');
  }

  const sides = await db
    .select({ id: issues.id, projectId: issues.projectId })
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

  // ISS-40 PR-E — only `blocks` edges gate dispatch, so they're the only
  // ones that can deadlock the dispatcher. Cycle-check before insert.
  if (input.kind === 'blocks') {
    const cycle = await detectCycle(input.toIssueId, input.fromIssueId);
    if (cycle === 'cycle') {
      throw new Error('CYCLE_DETECTED: adding this blocks edge would form a loop');
    }
    if (cycle === 'depth_exceeded') {
      throw new Error('CYCLE_DEPTH_EXCEEDED: dependency graph exceeds detection depth');
    }
  }

  const inserted = await db
    .insert(issueDependencies)
    .values({
      projectId: input.projectId,
      fromIssueId: input.fromIssueId,
      toIssueId: input.toIssueId,
      kind: input.kind,
      reason: input.reason ?? null,
      createdById: device.ownerId,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
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

  if (inserted.length > 0) {
    const id = inserted[0]?.id;
    if (!id) throw new Error('forge_pm.set_dependency: insert returned no row');
    await hooks.emit('dependencyChanged', {
      projectId: input.projectId,
      edgeId: id,
      fromIssueId: input.fromIssueId,
      toIssueId: input.toIssueId,
      kind: input.kind,
    });
    const dependencyPayload: Record<string, unknown> = {
      edgeId: id,
      fromIssueId: input.fromIssueId,
      toIssueId: input.toIssueId,
      kind: input.kind,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    const actor = { type: 'device' as const, id: device.id };
    await Promise.all([
      safeRecordActivity({
        issueId: input.fromIssueId,
        actor,
        action: 'issue.dependency.added',
        payload: dependencyPayload,
      }),
      safeRecordActivity({
        issueId: input.toIssueId,
        actor,
        action: 'issue.dependency.added',
        payload: dependencyPayload,
      }),
    ]);
    // ISS-138 (PR-D) — integration branch auto-fill on decomposes edges.
    // The helper is idempotent: the edge we just inserted is detected as
    // existing and skipped, but branch creation + metadata writes happen
    // (or short-circuit if the parent already owns an integration branch).
    await maybeRunDecomposeHelper(input, device.ownerId);
    // ISS-164 — `blocks` / `decomposes` edges change the gated side's
    // waiting reason; refresh pipelineHealth for the dependent (`to`) side.
    if (input.kind === 'blocks' || input.kind === 'decomposes') {
      await publishPipelineHealthChanged(input.projectId, [input.toIssueId]);
    }
    return { id, created: true };
  }

  const [existing] = await db
    .select({ id: issueDependencies.id })
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
  if (!existing) {
    throw new Error('forge_pm.set_dependency: conflict but no existing row found');
  }
  // ISS-138 (PR-D) — even on conflict (edge was already there), run the
  // helper so a parent whose first decompose call predated PR-D can still
  // be brought up to date when a new edge is added later.
  await maybeRunDecomposeHelper(input, device.ownerId);
  return { id: existing.id, created: false };
}

async function maybeRunDecomposeHelper(
  input: z.infer<typeof pmSetDependencyInputSchema>,
  ownerId: string,
): Promise<void> {
  if (input.kind !== 'decomposes') return;
  if (input.decomposeOpts?.useIntegrationBranch === false) {
    // Honour explicit opt-out without invoking the helper at all — this keeps
    // the no-git-side-effect contract for callers that just want to model
    // decomposition without a shared integration branch.
    return;
  }
  try {
    await decomposeParent(
      input.fromIssueId,
      [{ existingIssueId: input.toIssueId }],
      { userId: ownerId },
      { useIntegrationBranch: input.decomposeOpts?.useIntegrationBranch },
    );
  } catch (err) {
    // Do not fail the edge write if the integration branch could not be
    // created — the agent's decomposition step still records the edge.
    // PR-E will add an explicit reconciliation path.
    logger.warn(
      { err, parentId: input.fromIssueId, childId: input.toIssueId },
      'forge_pm.set_dependency: decompose helper failed for decomposes edge',
    );
  }
}

function recordDeprecation(ctx: McpContext, toolName: string) {
  if (deprecationFor(toolName) && ctx.deprecations) ctx.deprecations.add(toolName);
}

export const forgePmSetDependencyTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pm.set_dependency',
  description:
    "[DEPRECATED — use forge_project_pm (action=set_dependency)] Record a dependency edge (blocks/relates/duplicates/parent/decomposes) between two issues in the same project. Idempotent on (projectId, fromIssueId, toIssueId, kind) — duplicate calls return the existing row with created:false. Caller must be a member of the project. Dispatcher convention (ISS-40 PR-E): only `kind='blocks'` rows gate dispatch — `(from=A, to=B, kind='blocks')` means A must reach a terminal status (released/closed) before B can dispatch. For `blocks` edges, cycles are rejected with a CYCLE_DETECTED error. ISS-138 (PR-D): when `kind='decomposes'`, the first edge added to a parent also triggers integration-branch creation + branchConfig auto-fill on parent and child. Pass `decomposeOpts.useIntegrationBranch: false` to opt out (children then branch off the project default).",
  inputSchema: zodToMcpSchema(pmSetDependencyInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pm.set_dependency');
    const input = pmSetDependencyInputSchema.parse(args);
    return pmSetDependencyHandler(ctx.device, input);
  },
});
