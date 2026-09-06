/**
 * ISS-145 — Action-dispatcher consolidating the `forge_pm.<action>` family
 * into a single `forge_project_pm` tool, mirroring the shape of
 * `forge_issues` / `forge_comments`. `flag_blocker` and the standalone
 * `escalate` tool were removed in ISS-146; escalation now lives on
 * `write_decision.escalate`, so six actions is the whole surface.
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
import { PM_DECISION_CAUSES } from '../../pm/decisions-service.js';
import { PM_GRAPH_MAX_DEPTH } from '../../pm/graph-service.js';
import { pmDispatchHandler } from './forge-pm-dispatch.js';
import { pmGraphHandler } from './forge-pm-graph.js';
import { pmRunnerLoadHandler } from './forge-pm-runner-load.js';
import { pmSetDependencyHandler } from './forge-pm-set-dependency.js';
import { pmSnapshotHandler } from './forge-pm-snapshot.js';
import { pmWriteDecisionHandler } from './forge-pm-write-decision.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from './lib.js';
import { PM_ACTIONS } from './pm-actions.js';
import { assertPmActor } from './project-authz.js';

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
    action: z.enum(PM_ACTIONS),
    projectId: z.uuid(),

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

export const forgeProjectPmTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_project_pm',
  description:
    `PM agent action dispatcher. Actions: ${PM_ACTIONS.join(' | ')}. ` +
    // cm:guard do NOT enumerate the reachable/unreachable split here — `assertPmActor` in project-authz.ts derives it from PM_ACTIONS and delivers it at the moment a caller hits the gate. A hand-typed copy here would advertise a device-only action as reachable with every test still green.
    'CREDENTIAL CLASS: dispatch and write_decision act on runner state and are not reachable over MCP — they refuse with PM_REQUIRES_DEVICE, and the refusal names the actions that do work. To set or retract a blocks/relates edge, forge_issues create/update data.relations also works and reads back from forge_issues get. ' +
    'snapshot/graph/runner_load: read-only; require projectId + project membership. ' +
    'graph also accepts optional rootIssueId (BFS) and depth (default 2, max 5); without rootIssueId returns the full graph capped at 200 nodes with truncated:true + remainingNodes:N. ' +
    'dispatch: enqueue a coder-skill job for an issue (projectId, issueId, jobType, reason; optional payload, modelTier); requires PM-actor capability, so not reachable over MCP. ' +
    'set_dependency: record a dependency edge (projectId, fromIssueId, toIssueId, kind; optional reason, validUntil); idempotent — a repeat call returns created:false and applies whichever of `validUntil`/`reason` you passed (`updated:true` when it changed something). Expire a stale edge by setting `validUntil` in the past; that is the only agent-reachable retraction (DELETE is JWT-only REST). When creating a NEW issue that needs a blocking edge, prefer forge_issues.create { data.relations } (atomic, edges committed before issueCreated fires) or create the issue as status:draft first — a blocks edge set after an open create can miss the first dispatch tick. ' +
    'write_decision: durable PM decision turn (projectId, cause, summary; optional sessionId, eventRef, actions, confidence, modelTier, tookMs, escalate); requires PM-actor capability. To escalate alongside the decision, pass an `escalate` object — top-level `summary` is the decision summary, `escalate.summary` becomes the notification title.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    switch (input.action) {
      case 'snapshot': {
        return pmSnapshotHandler(principal, { projectId: input.projectId });
      }
      case 'graph': {
        return pmGraphHandler(principal, {
          projectId: input.projectId,
          rootIssueId: input.rootIssueId,
          depth: input.depth ?? 2,
        });
      }
      case 'runner_load': {
        return pmRunnerLoadHandler(principal, { projectId: input.projectId });
      }
      case 'dispatch': {
        // cm:guard `dispatch` gets NO credential refusal, and that is deliberate: `dispatchPmJob` already throws unconditionally because ISS-895 removed the staged lane, and THAT is the condition a caller needs to read. Adding `assertPmActor` here would preempt it with "needs a paired device", sending an operator to pair a box for an action that has no lane to run in either way — the wrong condition, which is what ISS-787/ISS-868 were about.
        if (!input.issueId) {
          throw new Error('BAD_REQUEST: issueId is required for dispatch');
        }
        if (!input.jobType) {
          throw new Error('BAD_REQUEST: jobType is required for dispatch');
        }
        if (!input.reason) {
          throw new Error('BAD_REQUEST: reason is required for dispatch');
        }
        return pmDispatchHandler(principal, {
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
        return pmSetDependencyHandler(principal, {
          projectId: input.projectId,
          fromIssueId: input.fromIssueId,
          toIssueId: input.toIssueId,
          kind: input.kind,
          reason: input.reason,
          validUntil: input.validUntil,
        });
      }
      case 'write_decision': {
        // cm:guard the CREDENTIAL refusal comes before the required-field checks. `assertPmActor` refuses every caller `/mcp` can produce (ISS-931), so validating `cause` first answers "cause is required" to a caller who could not use the action with every field supplied. Until ISS-931 this ordering came from `DEVICE_REQUIRED` in `mcp/server.ts`, which ran before the tool; that map is gone and this line is what replaced it.
        await assertPmActor(principal);
        if (!input.cause) {
          throw new Error('BAD_REQUEST: cause is required for write_decision');
        }
        if (!input.summary) {
          throw new Error('BAD_REQUEST: summary is required for write_decision');
        }
        return pmWriteDecisionHandler(principal, {
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
