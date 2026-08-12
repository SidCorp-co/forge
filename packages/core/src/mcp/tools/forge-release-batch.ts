/**
 * ISS-764 — MCP tool `forge_release_batch` for the release_batch job agent.
 *
 * The agent calls this tool (NOT forge_step_start) as the entry point and for
 * the finish/abort lifecycle. The run is issue-less (kind='system',
 * metadata.source='release-batch'); there is no forge_step_start call.
 *
 * Actions:
 *  - get    — load batch context: roster + releaseNotes per issue, branches,
 *             deployPlanned. Call FIRST.
 *  - finish — close every claimed issue tested→closed via transitionIssueStatus.
 *             Idempotent (second call is a clean no-op).
 *  - abort  — release all claims, write one comment per issue, close nothing.
 *
 * Authorization: get is member-gated (read); finish/abort are writer-gated
 * (mutating — closes/aborts issues). The tool does not require a real device
 * runner — PAT principals can call it.
 */

import { z } from 'zod';
import {
  abortReleaseBatch,
  finishReleaseBatch,
  loadReleaseBatchContext,
} from '../../release-batch/service.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['get', 'finish', 'abort']),
    runId: z.uuid(),
    /** abort only — human-readable reason for the abort. */
    reason: z.string().optional(),
  })
  .strict();

export const forgeReleaseBatchTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_release_batch',
  description:
    'Lifecycle control for a batch release job (ISS-764). The release_batch agent uses this tool ' +
    'instead of forge_step_start (the run is issue-less). ' +
    'get: load the batch context — roster of claimed issues (id, displayId, title, releaseNotes, status), ' +
    'baseBranch, productionBranch, deployPlanned. Call this FIRST to know what to merge+deploy+changelog. ' +
    'finish: close every claimed issue from gateStatus→closed via transitionIssueStatus. ' +
    'Idempotent: a second call finds no claimed issues and returns closed:[]. ' +
    'Also closes the batch pipeline run (completed). ' +
    'abort: release all claims (issues remain at their current status), write one comment per issue ' +
    'explaining the abort reason, close nothing. Use when a merge conflict, deploy failure, or ' +
    'pendingHumanConfirm prevents the batch from completing. ' +
    'Authorization: get requires project membership; finish and abort require writer role.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal, device } = ctx;

    switch (input.action) {
      case 'get': {
        const context = await loadReleaseBatchContext(input.runId);
        if (!context) {
          return { error: 'NOT_FOUND', runId: input.runId };
        }
        await assertPrincipalIsMember(principal, context.projectId);
        return context;
      }

      case 'finish': {
        const context = await loadReleaseBatchContext(input.runId);
        if (!context) {
          return { error: 'NOT_FOUND', runId: input.runId };
        }
        await assertPrincipalIsWriter(principal, context.projectId);

        const actor =
          principal.kind === 'pat'
            ? ({ type: 'user', id: principal.userId } as const)
            : ({ type: 'device', id: device.id, ownerId: device.ownerId } as const);

        const result = await finishReleaseBatch(input.runId, actor);
        return result;
      }

      case 'abort': {
        const context = await loadReleaseBatchContext(input.runId);
        if (!context) {
          return { error: 'NOT_FOUND', runId: input.runId };
        }
        await assertPrincipalIsWriter(principal, context.projectId);

        const actorUserId = principal.kind === 'pat' ? principal.userId : device.ownerId;

        const releasedIds = await abortReleaseBatch(
          input.runId,
          input.reason ?? 'aborted by agent',
          actorUserId,
        );
        return { aborted: true, releasedIds };
      }
    }
  },
});
