import { z } from 'zod';
import { divergenceCharterEntrySchema } from '../../skills/divergence-charters.js';
import { readCharter, upsertCharterAtomic } from '../../skills/divergence-charters-service.js';
import {
  assertPrincipalIsAdmin,
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  principalUserId,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['get', 'upsert']),
    projectId: z.uuid().optional(),
    /** Required for action=upsert: full replacement of the charter's entries. */
    entries: z.array(divergenceCharterEntrySchema).optional(),
    /** Optional human-readable reason for the upsert (written to the activity log). */
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

export const forgeDivergenceChartersTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_divergence_charters',
  description:
    "Read or write a project's Divergence Charter — the machine-readable record of intentional deviations from the default pipeline template (Update Pipeline §5, ISS-795). One charter per project; entries are owner-authored statements (difference/reason/incidentRefs/revertable). Action `get` (member-gated) returns the charter or null. Action `upsert` (admin-gated) creates or fully replaces the charter's entries and emits `charter.changed` into the skill activity log in the same transaction (invariant §9.11). The charter is item 7 in the Master agent's context bundle — never edit the entries a reconcile agent authored without explicit owner intent.",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);

    if (input.action === 'get') {
      await assertPrincipalIsMember(ctx.principal, projectId);
      const charter = await readCharter(projectId);
      return { charter };
    }

    await assertPrincipalIsAdmin(ctx.principal, projectId);

    const entries = input.entries;
    if (!entries) {
      throw new Error('BAD_REQUEST: entries is required for action=upsert');
    }

    const actor = `human:${principalUserId(ctx.principal)}`;

    const charter = await upsertCharterAtomic({
      projectId,
      entries,
      actor,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    return { charter };
  },
});
