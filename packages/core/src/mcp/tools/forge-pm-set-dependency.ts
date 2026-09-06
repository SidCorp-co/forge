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
 * ISS-145: the handler body is `pmSetDependencyHandler`, called both by the
 * `forge_project_pm` dispatcher and by the shim factory below, which stays
 * registered because forge-plan, forge-triage and forge-build call
 * `forge_pm.set_dependency` by name.
 */

import { z } from 'zod';
import { issueDependencyKinds } from '../../db/schema.js';
import { IssueDependencyError, setIssueDependency } from '../../issues/dependency-service.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { deprecationFor } from '../deprecation.js';
import {
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalHookActor,
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
  })
  .strict();

// cm:guard the `actor` is the PRINCIPAL's, derived here and never defaulted. Until ISS-931 this took a `Device` and fell back to `{type:'device', id: device.id}`, which for a PAT was the synthetic stub's id — so a PERSON's edge was recorded as a device while the same request's status transition read as that person through `principalActor`. One request, two attributions, and the disagreement was invisible in the row.
export async function pmSetDependencyHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pmSetDependencyInputSchema>,
  opts?: { deferHealthPublish?: boolean },
) {
  // cm:guard gate on plain project membership, NOT the PM capability flag (ISS-131, was `assertPmActor`) — plan-pipeline agents must declare blocks edges while writing a plan and run on `claude-code` runners that carry no PM flag; the cycle guard and the unique-index idempotency already cover the abuse surface. This line is also why the action is NOT in the device-only set: ISS-150 gated the whole `forge_pm.*` family, ISS-868 pruned three of the survivors, and this one was left behind refusing 651 lifetime calls for a capability its own gate never asks for (ISS-931).
  await assertPrincipalIsMember(principal, input.projectId);

  try {
    return await setIssueDependency(
      input,
      { actor: principalHookActor(principal), createdById: principal.userId },
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
    "[DEPRECATED — use forge_project_pm (action=set_dependency)] Record a dependency edge (blocks/relates/duplicates/parent/decomposes) between two issues in the same project. Only `blocks` gates anything; `decomposes` is a grouping label with no lifecycle of its own. Idempotent on (projectId, fromIssueId, toIssueId, kind) — a duplicate call returns created:false and applies whichever of `validUntil`/`reason` you passed, reporting `updated:true` when it changed something. Expire an edge by setting `validUntil` in the past; that is the only way an agent can retract one (DELETE is JWT-only REST). Omitted fields are left alone. Caller must be a member of the project. Dispatcher convention (ISS-40 PR-E): only `kind='blocks'` rows gate dispatch — `(from=A, to=B, kind='blocks')` means B waits for A's `merged_at` stamp; a reopened A blocks again, and a closed A without that stamp unblocks B only on a structurally unstampable base. For `blocks` edges, cycles are rejected with a CYCLE_DETECTED error.",
  inputSchema: zodToMcpSchema(pmSetDependencyInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pm.set_dependency');
    const input = pmSetDependencyInputSchema.parse(args);
    return pmSetDependencyHandler(ctx.principal, input);
  },
});
