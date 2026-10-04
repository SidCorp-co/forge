// cm:why the MCP door to what the project master is doing and the passes it ran (ISS-108, domain-entities
// item 43): the same reads REST serves at /api/projects/:id/masters/standing and /masters/passes; the pass and
// slot writes stay device routes a runner calls with its own credential

import { MASTER_PASS_PAGE_DEFAULT, MASTER_PASS_PAGE_MAX } from '@forge/contracts/master-standing';
import { z } from 'zod';
import { guideRef } from '../../guides/guide-ref.js';
import { listMasterPasses, readMasterStanding } from '../../masters/read.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';
import { requireCan } from '../../permissions/index.js';

const ACTIONS = ['standing', 'passes'] as const;

const inputSchema = z
  .object({
    action: z.enum(ACTIONS),
    projectId: z.uuid().optional(),
    limit: z.number().int().min(1).max(MASTER_PASS_PAGE_MAX).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    sessionId: z.uuid().optional(),
  })
  .strict();

const DESCRIPTION =
  `The project master (${guideRef('runs-and-masters')}). Actions: ${ACTIONS.join(' | ')}. ` +
  'standing: state in_pass | idle | silent | none, the session and its box, the open pass {verb, startedAt, issueKey}, the last closed pass {dispatched, skipped [{issueKey, refusal}], parked}, slots {inUse, max, undeclared} and lastBeatAt. ' +
  `passes: the stored passes, newest first; limit (default ${MASTER_PASS_PAGE_DEFAULT}, max ${MASTER_PASS_PAGE_MAX}), before = the \`next\` a page answered, sessionId to read one master's. Read hasMore before calling the history complete.`;

async function run(args: unknown, ctx: McpContext): Promise<unknown> {
  const input = inputSchema.parse(args);
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  await requireCan({ userId: ctx.principal.userId }, 'project.read', projectId);
  if (input.action === 'standing') return readMasterStanding(projectId);
  return listMasterPasses(projectId, {
    limit: input.limit ?? MASTER_PASS_PAGE_DEFAULT,
    before: input.before ?? null,
    sessionId: input.sessionId ?? null,
  });
}

export const forgeMastersTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_masters',
  reach: 'project',
  route: '/api/projects/:id/masters/standing',
  grant: { byAction: { standing: 'projects:read', passes: 'projects:read' } },
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});
