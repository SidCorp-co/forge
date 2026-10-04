// cm:why the MCP door to the runs read model (ISS-108): the same read functions REST serves at
// /api/projects/:id/runs/standing and /runs/standing/:runId; the master's own door is forge_masters

import {
  RUN_STANDING_LIST_MAX,
  RUN_STANDING_SCOPES,
  runSummaryOf,
} from '@forge/contracts/run-standing';
import { z } from 'zod';
import { egressDeep, egressOr } from '../../lib/data-egress.js';
import { listRunStanding, readRunStanding } from '../../runs/read.js';
import {
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalAgency,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';
import { projectMany, projectOne, summaryNotice, VIEW_RULE, viewInput } from './projection.js';

const ACTIONS = ['list', 'get'] as const;
const MCP_LIST_DEFAULT = 20;

const inputSchema = z
  .object({
    action: z.enum(ACTIONS),
    projectId: z.uuid().optional(),
    runId: z.uuid().optional(),
    scope: z.enum(RUN_STANDING_SCOPES).optional(),
    limit: z.number().int().min(1).max(RUN_STANDING_LIST_MAX).optional(),
    offset: z.number().int().min(0).optional(),
    view: viewInput,
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const DESCRIPTION =
  `Runs and the project master, as core derives them (design agent-run-standing). Actions: ${ACTIONS.join(' | ')}. ` +
  'list: every run of the project (pipeline runs, not chats or a master’s own run) with state queued | claimed | running | waiting_person | waiting_gate | done | failed | cancelled | handed_back, ' +
  'its holder (expiresAt + expirySource claim | silence_reap | deploy_lock), what it waits on (a person {who, act, ref, since} or a gate {gate, resumesAt or null}), its outcome, attempt {n, retryOf} and master; ' +
  `scope live (default) | finished | all, limit (default ${MCP_LIST_DEFAULT}), offset. Read hasMore before calling a count complete. ` +
  'stuck reads source not_computed until core computes it (ISS-109): it is no claim that a run is not stuck. ' +
  `get: one run by runId, with every attempt over the same issue. What the project master is doing: forge_masters. ${VIEW_RULE}`;

function need<K extends keyof Input>(input: Input, key: K): NonNullable<Input[K]> {
  const value = input[key];
  if (value === undefined || value === null) {
    throw new Error(`BAD_REQUEST: ${input.action} needs ${String(key)}`);
  }
  return value as NonNullable<Input[K]>;
}

async function run(args: unknown, ctx: McpContext): Promise<unknown> {
  const input = inputSchema.parse(args);
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  await assertPrincipalIsMember(ctx.principal, projectId);
  const viewer =
    principalAgency(ctx.principal) === 'human' ? { userId: ctx.principal.userId } : null;
  switch (input.action) {
    case 'list': {
      const listed = await listRunStanding(
        projectId,
        {
          scope: input.scope ?? 'live',
          limit: input.limit ?? MCP_LIST_DEFAULT,
          offset: input.offset ?? 0,
        },
        viewer,
      );
      const read = await egressDeep(projectId, 'issue', listed, 'the run list');
      if (!read.ok) return egressOr(read, { projectId, total: listed.total });
      return {
        ...read.value,
        items: projectMany(input.view, read.value.items, runSummaryOf),
        ...summaryNotice(
          input.view,
          "view: 'full' for each run's master, deploy locks, release and rule",
        ),
      };
    }
    case 'get': {
      const detail = await readRunStanding(projectId, need(input, 'runId'), viewer);
      if (!detail) throw new Error(`NOT_FOUND: run ${input.runId} is not a run of this project`);
      const read = await egressDeep(projectId, 'issue', detail, `run ${input.runId}`);
      if (!read.ok) return egressOr(read, { runId: input.runId });
      return { ...read.value, run: projectOne(input.view ?? 'full', read.value.run, runSummaryOf) };
    }
  }
}

export const forgeRunsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_runs',
  reach: 'project',
  route: '/api/projects',
  grant: { byAction: { list: 'projects:read', get: 'projects:read' } },
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});
