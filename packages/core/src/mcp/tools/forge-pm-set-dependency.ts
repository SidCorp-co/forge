import { z } from 'zod';
import { issueDependencyKinds } from '../../db/schema.js';
import { GATES_DISPATCH_NOTE, WORK_EVIDENCE_WAIVER_NOTE } from '../../issues/dependency-effects.js';
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

export async function pmSetDependencyHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pmSetDependencyInputSchema>,
  opts?: { deferHealthPublish?: boolean },
) {
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
    '[DEPRECATED — use forge_project_pm (action=set_dependency)] Record a dependency edge (blocks/relates/duplicates/parent/decomposes) between two issues in the same project. Only `blocks` gates dispatch. ' +
    WORK_EVIDENCE_WAIVER_NOTE +
    " The result's `effects` names what the edge you just wrote actually does. Idempotent on (projectId, fromIssueId, toIssueId, kind) — a duplicate call returns created:false and applies whichever of `validUntil`/`reason` you passed, reporting `updated:true` when it changed something. Expire an edge by setting `validUntil` in the past; that is the only way an agent can retract one (DELETE is JWT-only REST). Omitted fields are left alone. Caller must be a member of the project. Dispatcher convention (ISS-40 PR-E): only `kind='blocks'` rows gate dispatch. " +
    GATES_DISPATCH_NOTE +
    ' For `blocks` edges, cycles are rejected with a CYCLE_DETECTED error.',
  inputSchema: zodToMcpSchema(pmSetDependencyInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pm.set_dependency');
    const input = pmSetDependencyInputSchema.parse(args);
    return pmSetDependencyHandler(ctx.principal, input);
  },
});
