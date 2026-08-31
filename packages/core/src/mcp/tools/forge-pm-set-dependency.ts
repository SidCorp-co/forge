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

import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { issueDependencyKinds } from '../../db/schema.js';
import { IssueDependencyError, setIssueDependency } from '../../issues/dependency-service.js';
import type { Actor } from '../../pipeline/activity.js';
import { deprecationFor } from '../deprecation.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from './lib.js';
import { assertDeviceOwnerIsMember } from './project-authz.js';

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
    decomposeOpts: z.object({ useIntegrationBranch: z.boolean().optional() }).strict().optional(),
  })
  .strict();

// cm:guard pass `actor` whenever the caller knows its principal — a PAT reaches here behind a SYNTHETIC device (mcp/handler.ts stubDeviceForPat) whose id is an api_tokens row, so the default writes an activity_log actor_id that matches no `devices` row while the same request's status transition is attributed correctly through principalActor()
export async function pmSetDependencyHandler(
  device: Device,
  input: z.infer<typeof pmSetDependencyInputSchema>,
  actorOverride?: Actor,
  opts?: { deferHealthPublish?: boolean },
) {
  // cm:guard gate on plain project membership, NOT the PM capability flag (ISS-131, was `assertPmActor`) — plan-pipeline agents must declare blocks/decomposes edges while writing a plan and run on `claude-code` runners that carry no PM flag; the cycle guard and the unique-index idempotency already cover the abuse surface
  await assertDeviceOwnerIsMember(device, input.projectId);

  try {
    return await setIssueDependency(
      input,
      {
        actor: actorOverride ?? { type: 'device' as const, id: device.id },
        createdById: device.ownerId,
      },
      opts,
    );
  } catch (err) {
    throw toMcpDependencyError(err);
  }
}

// cm:edge lockstep -> packages/core/src/issues/dependency-service.ts — every IssueDependencyErrorCode needs a case here; the agent-facing contract is the `CODE: message` prefix, which forge-pm-set-dependency.test.ts asserts by string
function toMcpDependencyError(err: unknown): unknown {
  if (!(err instanceof IssueDependencyError)) return err;
  switch (err.code) {
    case 'SELF_DEP':
      return new Error('BAD_REQUEST: self-edge not allowed');
    case 'NOT_FOUND':
      return new Error('NOT_FOUND: one or both issues not found');
    case 'CROSS_PROJECT':
      return new Error('BAD_REQUEST: both issues must belong to projectId');
    case 'CYCLE_DETECTED':
      return new Error('CYCLE_DETECTED: adding this blocks edge would form a loop');
    case 'CYCLE_DEPTH_EXCEEDED':
      return new Error('CYCLE_DEPTH_EXCEEDED: dependency graph exceeds detection depth');
    default:
      return new Error(`forge_pm.set_dependency: ${err.code}`);
  }
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
