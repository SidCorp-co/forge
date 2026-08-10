/**
 * ISS-145 — Action-dispatcher consolidating six of the eight
 * `forge_pm.<action>` tools into a single `forge_project_pm` tool, mirroring
 * the shape of `forge_issues` / `forge_comments`. The two omitted actions
 * (`flag_blocker`, `escalate`) stay as standalone tools per the issue's
 * acceptance criterion which only lists six actions in scope.
 *
 * Implementation lives in the per-action pure handlers exported by each
 * `./forge-pm-*.ts` file. This dispatcher owns input validation,
 * required-field checks per action, and routing. Authorization is
 * re-applied inside each handler (`assertDeviceOwnerIsMember` for the
 * read-only / cycle-checked actions, `assertPmActor` for `dispatch` and
 * `write_decision`) — the dispatcher does NOT collapse auth into a single
 * pre-switch call.
 */

import { z } from 'zod';
import { issueDependencyKinds, jobTypes, modelTiers } from '../../db/schema.js';
import { pmDispatchHandler } from './forge-pm-dispatch.js';
import { pmGraphHandler, PM_GRAPH_MAX_DEPTH } from './forge-pm-graph.js';
import { pmRunnerLoadHandler } from './forge-pm-runner-load.js';
import { pmSetDependencyHandler } from './forge-pm-set-dependency.js';
import { pmSnapshotHandler } from './forge-pm-snapshot.js';
import {
  PM_DECISION_CAUSES,
  pmWriteDecisionHandler,
} from './forge-pm-write-decision.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from './lib.js';

const escalateSchema = z
  .object({
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    summary: z.string().min(1).max(2000),
    question: z.string().min(1).max(2000),
    options: z
      .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(255) }))
      .min(1)
      .max(8),
    expiresAt: z.iso.datetime(),
  })
  .strict();

const inputSchema = z
  .object({
    action: z.enum([
      'snapshot',
      'graph',
      'runner_load',
      'dispatch',
      'set_dependency',
      'write_decision',
    ]),
    projectId: z.uuid(),
    // graph
    rootIssueId: z.uuid().optional(),
    depth: z.number().int().min(1).max(PM_GRAPH_MAX_DEPTH).optional(),
    // dispatch
    issueId: z.uuid().optional(),
    jobType: z.enum(jobTypes).optional(),
    reason: z.string().min(1).max(2000).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    modelTier: z.enum(modelTiers).optional(),
    // set_dependency
    fromIssueId: z.uuid().optional(),
    toIssueId: z.uuid().optional(),
    kind: z.enum(issueDependencyKinds).optional(),
    validUntil: z.iso.datetime().optional(),
    decomposeOpts: z
      .object({ useIntegrationBranch: z.boolean().optional() })
      .strict()
      .optional(),
    // write_decision
    sessionId: z.uuid().optional(),
    cause: z.enum(PM_DECISION_CAUSES).optional(),
    eventRef: z.record(z.string(), z.unknown()).optional(),
    summary: z.string().min(1).max(4000).optional(),
    actions: z.array(z.record(z.string(), z.unknown())).optional(),
    confidence: z.number().min(0).max(1).optional(),
    tookMs: z.number().int().min(0).optional(),
    escalate: escalateSchema.optional(),
  })
  .strict();

export const forgeProjectPmTool: ContextScopedMcpToolFactory = ({ device }) => ({
  name: 'forge_project_pm',
  description:
    'PM agent action dispatcher. Actions: snapshot | graph | runner_load | dispatch | set_dependency | write_decision. ' +
    'snapshot/graph/runner_load: read-only; require projectId + project membership. ' +
    'graph also accepts optional rootIssueId (BFS) and depth (default 2, max 5); without rootIssueId returns the full graph capped at 200 nodes with truncated:true + remainingNodes:N. ' +
    'dispatch: enqueue a coder-skill job for an issue (projectId, issueId, jobType, reason; optional payload, modelTier); requires PM-actor capability. ' +
    'set_dependency: record a dependency edge (projectId, fromIssueId, toIssueId, kind; optional reason, validUntil, decomposeOpts); idempotent. When creating a NEW issue that needs a blocking edge, prefer forge_issues.create { data.relations } (atomic, edges committed before issueCreated fires) or create the issue as status:draft first — a blocks edge set after an open create can miss the first dispatch tick. ' +
    'write_decision: durable PM decision turn (projectId, cause, summary; optional sessionId, eventRef, actions, confidence, modelTier, tookMs, escalate); requires PM-actor capability. To escalate alongside the decision, pass an `escalate` object — top-level `summary` is the decision summary, `escalate.summary` becomes the notification title.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    switch (input.action) {
      case 'snapshot': {
        return pmSnapshotHandler(device, { projectId: input.projectId });
      }
      case 'graph': {
        return pmGraphHandler(device, {
          projectId: input.projectId,
          rootIssueId: input.rootIssueId,
          depth: input.depth ?? 2,
        });
      }
      case 'runner_load': {
        return pmRunnerLoadHandler(device, { projectId: input.projectId });
      }
      case 'dispatch': {
        if (!input.issueId) {
          throw new Error('BAD_REQUEST: issueId is required for dispatch');
        }
        if (!input.jobType) {
          throw new Error('BAD_REQUEST: jobType is required for dispatch');
        }
        if (!input.reason) {
          throw new Error('BAD_REQUEST: reason is required for dispatch');
        }
        return pmDispatchHandler(device, {
          projectId: input.projectId,
          issueId: input.issueId,
          jobType: input.jobType,
          reason: input.reason,
          payload: input.payload,
          modelTier: input.modelTier,
        });
      }
      case 'set_dependency': {
        if (!input.fromIssueId) {
          throw new Error('BAD_REQUEST: fromIssueId is required for set_dependency');
        }
        if (!input.toIssueId) {
          throw new Error('BAD_REQUEST: toIssueId is required for set_dependency');
        }
        if (!input.kind) {
          throw new Error('BAD_REQUEST: kind is required for set_dependency');
        }
        return pmSetDependencyHandler(device, {
          projectId: input.projectId,
          fromIssueId: input.fromIssueId,
          toIssueId: input.toIssueId,
          kind: input.kind,
          reason: input.reason,
          validUntil: input.validUntil,
          decomposeOpts: input.decomposeOpts,
        });
      }
      case 'write_decision': {
        if (!input.cause) {
          throw new Error('BAD_REQUEST: cause is required for write_decision');
        }
        if (!input.summary) {
          throw new Error('BAD_REQUEST: summary is required for write_decision');
        }
        return pmWriteDecisionHandler(device, {
          projectId: input.projectId,
          sessionId: input.sessionId,
          cause: input.cause,
          eventRef: input.eventRef ?? {},
          summary: input.summary,
          actions: input.actions ?? [],
          confidence: input.confidence,
          modelTier: input.modelTier,
          tookMs: input.tookMs,
          escalate: input.escalate,
        });
      }
    }
  },
});
