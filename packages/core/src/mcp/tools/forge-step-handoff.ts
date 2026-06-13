import { z } from 'zod';
import {
  deleteIssueContext,
  getIssueContexts,
  writeIssueContext,
} from '../../pipeline/issue-context-store.js';
import { stepHandoffSchema } from '../../memory/step-handoff-schema.js';
import { assertDeviceOwnerIsMember, zodToMcpSchema,
  assertDeviceOwnerIsWriter,
} from './lib.js';
import type { DeviceScopedMcpToolFactory } from './lib.js';

/**
 * MCP tools for step-handoff persistence (proposal Y). Thin wrappers over
 * `pipeline/issue-context-store.ts` with `kind='handoff'` hardcoded — agents
 * never specify the discriminator. The shared `stepHandoffSchema` validates
 * payloads (and the store cross-checks payload.step against scope.step so an
 * agent can't slip a plan payload into a triage slot).
 */

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
 * `forge_step_handoff.write` — upsert the structured output of a pipeline
 * step. Agents call this at the end of each handoff-emitting state before
 * emitting `DONE`. Upsert is keyed on `(issueId, step, attempt)`.
 */
export const forgeStepHandoffWriteTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_step_handoff.write',
  description:
    "Upsert a step handoff (structured pipeline-state output) for an issue. Stores `payload` under `kind='handoff'` keyed on (issueId, step, attempt). Validates payload via the per-step discriminated schema. Requires the device owner to be a project member.",
  inputSchema: zodToMcpSchema(writeInputSchema),
  handler: async (args) => {
    const input = writeInputSchema.parse(args);
    await assertDeviceOwnerIsWriter(device, input.projectId);
    return writeIssueContext({ ...input, kind: 'handoff' });
  },
});

/**
 * `forge_step_handoff.get` — list handoffs for an issue. Used by the
 * dispatcher pre-fetch path; also useful for ad-hoc agent queries when
 * inspecting prior state output. Defaults to latest-first by createdAt.
 */
export const forgeStepHandoffGetTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_step_handoff.get',
  description:
    'List step handoffs for an issue. Filter by pipelineRunId and/or `steps` allow-list. Returns rows sorted by createdAt (default desc). Requires the device owner to be a project member.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const input = getInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, input.projectId);
    const rows = await getIssueContexts({ ...input, kind: 'handoff' });
    return { rows };
  },
});

/**
 * `forge_step_handoff.delete` — idempotent delete by natural key. Returns
 * `{deleted: boolean}`. Rarely needed by agents; included for parity with
 * the memory tool family and operator manual recovery.
 */
export const forgeStepHandoffDeleteTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_step_handoff.delete',
  description:
    'Delete a step handoff by (issueId, step, attempt). Idempotent — returns {deleted: false} when no row matches. Requires the device owner to be a project member.',
  inputSchema: zodToMcpSchema(deleteInputSchema),
  handler: async (args) => {
    const input = deleteInputSchema.parse(args);
    await assertDeviceOwnerIsWriter(device, input.projectId);
    const n = await deleteIssueContext({ ...input, kind: 'handoff' });
    return { deleted: n > 0 };
  },
});
