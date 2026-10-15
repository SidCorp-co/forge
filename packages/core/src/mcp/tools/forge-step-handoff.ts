import { z } from 'zod';
import { stepHandoffSchema } from '../../memory/step-handoff-schema.js';
import {
  deleteIssueContext,
  getIssueContexts,
  HandoffDeleteRefused,
  HandoffRefused,
  IssueNotInProject,
  PipelineRunNotFound,
  writeIssueContext,
} from '../../pipeline/issue-context-store.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  principalHookActor,
  zodToMcpSchema,
} from './lib.js';

const writeInputSchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  pipelineRunId: z.uuid(),
  step: z.string().trim().min(1).max(64),
  attempt: z.number().int().positive().default(1),
  payload: stepHandoffSchema,
});

const getInputSchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  pipelineRunId: z.uuid().optional(),
  steps: z.array(z.string().min(1).max(64)).max(20).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  orderDir: z.enum(['asc', 'desc']).default('desc'),
});

const deleteInputSchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  step: z.string().trim().min(1).max(64),
  attempt: z.number().int().positive(),
});

/**
 * `forge_step_handoff.write` — the structured output of one run's step attempt, written once onto
 * that attempt's run journal row.
 */
export const forgeStepHandoffWriteTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_step_handoff.write',
  description:
    "Write a step handoff (structured pipeline-state output) for one run's step attempt: (pipelineRunId, step, attempt). It is written once; a second handoff for the same attempt is refused naming when the first was written, and a later round is a new attempt. Validates payload via the per-step discriminated schema. Requires project membership.",
  inputSchema: zodToMcpSchema(writeInputSchema),
  handler: async (args) => {
    const input = writeInputSchema.parse(args);
    await assertPrincipalIsWriter(principal, input.projectId);
    try {
      return await writeIssueContext({
        ...input,
        kind: 'handoff',
        actor: principalHookActor(principal),
      });
    } catch (err) {
      if (err instanceof IssueNotInProject || err instanceof PipelineRunNotFound)
        throw new Error(`NOT_FOUND: ${err.message}`);
      if (err instanceof HandoffRefused) throw new Error(`${err.code}: ${err.message}`);
      throw err;
    }
  },
});

/**
 * `forge_step_handoff.get` — list handoffs for an issue. Used by the
 * dispatcher pre-fetch path; also useful for ad-hoc agent queries when
 * inspecting prior state output. Defaults to latest-first by createdAt.
 */
export const forgeStepHandoffGetTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_step_handoff.get',
  description:
    'List step handoffs for an issue. Filter by pipelineRunId and/or `steps` allow-list. Returns rows sorted by createdAt (default desc). Requires project membership.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const input = getInputSchema.parse(args);
    await assertPrincipalIsMember(principal, input.projectId);
    const rows = await getIssueContexts({ ...input, kind: 'handoff' });
    return { rows };
  },
});

/**
 * `forge_step_handoff.delete` — refused by name: a handoff is its attempt's record on the run
 * journal, which keeps every attempt. Kept so an old caller is told why rather than met by nothing.
 */
export const forgeStepHandoffDeleteTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_step_handoff.delete',
  description:
    "Refused, always: a handoff is the run journal's record of its attempt and the journal keeps every attempt, so nothing is deleted. Answers HANDOFF_IS_JOURNAL.",
  inputSchema: zodToMcpSchema(deleteInputSchema),
  handler: async (args) => {
    const input = deleteInputSchema.parse(args);
    await assertPrincipalIsWriter(principal, input.projectId);
    try {
      return await deleteIssueContext({ ...input, kind: 'handoff' });
    } catch (err) {
      if (err instanceof HandoffDeleteRefused) throw new Error(`${err.code}: ${err.message}`);
      throw err;
    }
  },
});
