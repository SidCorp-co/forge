/**
 * The one edge-write path for `issue_dependencies`.
 *
 * ISS-889 — REST (`dependency-routes.ts`) and MCP (`forge-pm-set-dependency.ts`)
 * each carried their own insert. The REST copy was the weaker of the two: no
 * `validUntil`/`reason` on the conflict path (so an edge declared over REST
 * could not be retracted), no `dependencyChanged` emit on update, and no
 * `publishPipelineHealthChanged` at all — a web-declared blocker left the
 * dependent's waiting banner stale until some other event woke the dispatcher.
 *
 * Authorization stays at the transport edge: REST resolves a project role,
 * MCP asserts device-owner membership. This module takes inputs already
 * authorized and owns only the domain rules, so neither transport's error
 * vocabulary leaks into the other's.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueDependencies, type issueDependencyKinds, issues } from '../db/schema.js';
import { logger } from '../logger.js';
import { type Actor, safeRecordActivity } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { detectCycle } from './cycle-detect.js';
import { decomposeParent } from './decompose.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';

export type IssueDependencyKind = (typeof issueDependencyKinds)[number];

export type IssueDependencyErrorCode =
  | 'SELF_DEP'
  | 'NOT_FOUND'
  | 'CROSS_PROJECT'
  | 'CYCLE_DETECTED'
  | 'CYCLE_DEPTH_EXCEEDED'
  | 'INTERNAL';

// cm:guard carry the CODE, never a transport's wording — REST answers `cycle detected — adding this edge would form a loop` at 409 and MCP answers `CYCLE_DETECTED: adding this blocks edge would form a loop`, and both are asserted by their own tests; a shared message string silently rewrites one caller's contract
export class IssueDependencyError extends Error {
  constructor(readonly code: IssueDependencyErrorCode) {
    super(code);
    this.name = 'IssueDependencyError';
  }
}

export type SetIssueDependencyInput = {
  projectId: string;
  fromIssueId: string;
  toIssueId: string;
  kind: IssueDependencyKind;
  reason?: string | undefined;
  validUntil?: string | undefined;
  decomposeOpts?: { useIntegrationBranch?: boolean | undefined } | undefined;
};

/**
 * Who the write is attributed to. `createdById` lands in the row; `actor` is
 * what the activity log records.
 */
// cm:guard pass `actor` explicitly whenever the caller knows its principal — a PAT reaches MCP behind a SYNTHETIC device (mcp/handler.ts stubDeviceForPat) whose id is an api_tokens row, so a device-shaped default writes an activity_log actor_id matching no `devices` row while the same request's status transition is attributed correctly through principalActor()
export type IssueDependencyWriter = {
  actor: Actor;
  createdById: string;
};

export type SetIssueDependencyResult = {
  id: string;
  created: boolean;
  updated?: boolean;
};

/**
 * Idempotent on the unique edge `(project_id, from_issue_id, to_issue_id, kind)`.
 * A duplicate returns `created:false` and applies whichever of `validUntil` /
 * `reason` the caller supplied, reporting that as `updated`. Setting
 * `validUntil` into the past is how an edge is RETRACTED.
 */
// cm:edge lockstep -> packages/core/src/issues/dependency-routes.ts — the REST POST maps IssueDependencyError codes to status codes; a new code added here without a case there falls through as an unmapped 500
// cm:edge lockstep -> packages/core/src/mcp/tools/forge-pm-set-dependency.ts — same mapping on the MCP side, to its `CODE: message` string form
export async function setIssueDependency(
  input: SetIssueDependencyInput,
  writer: IssueDependencyWriter,
  opts?: { deferHealthPublish?: boolean },
): Promise<SetIssueDependencyResult> {
  if (input.fromIssueId === input.toIssueId) {
    throw new IssueDependencyError('SELF_DEP');
  }

  const sides = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, [input.fromIssueId, input.toIssueId]));
  if (sides.length !== 2) throw new IssueDependencyError('NOT_FOUND');
  for (const s of sides) {
    if (s.projectId !== input.projectId) throw new IssueDependencyError('CROSS_PROJECT');
  }

  // cm:why only kind='blocks' gates dispatch (ISS-40 PR-E), so it is the only kind whose cycle can deadlock the dispatcher — hence the check is not run for the others
  if (input.kind === 'blocks') {
    const cycle = await detectCycle(input.toIssueId, input.fromIssueId);
    if (cycle === 'cycle') throw new IssueDependencyError('CYCLE_DETECTED');
    if (cycle === 'depth_exceeded') throw new IssueDependencyError('CYCLE_DEPTH_EXCEEDED');
  }

  const inserted = await db
    .insert(issueDependencies)
    .values({
      projectId: input.projectId,
      fromIssueId: input.fromIssueId,
      toIssueId: input.toIssueId,
      kind: input.kind,
      reason: input.reason ?? null,
      createdById: writer.createdById,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
    })
    .onConflictDoNothing({
      target: [
        issueDependencies.projectId,
        issueDependencies.fromIssueId,
        issueDependencies.toIssueId,
        issueDependencies.kind,
      ],
    })
    .returning({ id: issueDependencies.id });

  if (inserted.length > 0) {
    const id = inserted[0]?.id;
    if (!id) throw new IssueDependencyError('INTERNAL');
    await emitEdgeChanged(input, id);
    await recordOnBothSides(input, id, writer.actor, 'issue.dependency.added', {
      ...(input.reason ? { reason: input.reason } : {}),
    });
    await maybeRunDecomposeHelper(input, writer.createdById);
    await refreshDependentHealth(input, opts);
    return { id, created: true };
  }

  const [existing] = await db
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(
      and(
        eq(issueDependencies.projectId, input.projectId),
        eq(issueDependencies.fromIssueId, input.fromIssueId),
        eq(issueDependencies.toIssueId, input.toIssueId),
        eq(issueDependencies.kind, input.kind),
      ),
    )
    .limit(1);
  if (!existing) throw new IssueDependencyError('INTERNAL');

  // cm:guard apply `validUntil`/`reason` on the CONFLICT path too — the write advertises both and the `onConflictDoNothing` above silently dropped them, which left a `blocks` edge retractable by no agent-reachable API at all (the DELETE route is JWT-only REST). It matters because a `dropped` blocker never stamps `merged_at`: on getcontent a consolidation dropped ISS-463 and its stale edge held ISS-455, and via ISS-455 held ISS-457, queued for 53h with nobody notified (measured 2026-08-22).
  // cm:why only the fields the caller actually sent — a bare re-assert of an existing edge is the common idempotent call, and blanking someone's expiry or reason because they omitted it is a silent data loss
  const patch: { validUntil?: Date; reason?: string } = {};
  if (input.validUntil) patch.validUntil = new Date(input.validUntil);
  if (input.reason) patch.reason = input.reason;
  const updated = Object.keys(patch).length > 0;

  if (updated) {
    await db.update(issueDependencies).set(patch).where(eq(issueDependencies.id, existing.id));
    // cm:guard emit `dependencyChanged` on an update, not just an insert — expiring an edge can make the gated side dispatchable THIS INSTANT, and without the emit the unblock waits for whatever else happens to wake the dispatcher
    await emitEdgeChanged(input, existing.id);
    await recordOnBothSides(input, existing.id, writer.actor, 'issue.dependency.updated', {
      ...(input.validUntil ? { validUntil: input.validUntil } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    await refreshDependentHealth(input, opts);
  }

  // cm:why run the helper on the conflict path too — a parent whose first decompose edge predated ISS-138 PR-D owns no integration branch, and a later duplicate edge is the only occasion left to fill it
  await maybeRunDecomposeHelper(input, writer.createdById);
  return { id: existing.id, created: false, updated };
}

async function emitEdgeChanged(input: SetIssueDependencyInput, edgeId: string): Promise<void> {
  await hooks.emit('dependencyChanged', {
    projectId: input.projectId,
    edgeId,
    fromIssueId: input.fromIssueId,
    toIssueId: input.toIssueId,
    kind: input.kind,
  });
}

async function recordOnBothSides(
  input: SetIssueDependencyInput,
  edgeId: string,
  actor: Actor,
  action: 'issue.dependency.added' | 'issue.dependency.updated',
  extra: Record<string, unknown>,
): Promise<void> {
  const payload: Record<string, unknown> = {
    edgeId,
    fromIssueId: input.fromIssueId,
    toIssueId: input.toIssueId,
    kind: input.kind,
    ...extra,
  };
  await Promise.all([
    safeRecordActivity({ issueId: input.fromIssueId, actor, action, payload }),
    safeRecordActivity({ issueId: input.toIssueId, actor, action, payload }),
  ]);
}

// cm:guard `deferHealthPublish` suppresses ONLY the WS refresh, never the edge write or the `dependencyChanged` hook — a caller that defers owes the batched `publishPipelineHealthChanged` itself, before whatever wakes the dispatcher (see relations-service.ts), or the dependent's waiting banner goes stale until the next event
async function refreshDependentHealth(
  input: SetIssueDependencyInput,
  opts?: { deferHealthPublish?: boolean },
): Promise<void> {
  if (opts?.deferHealthPublish) return;
  // cm:why ISS-164 — only blocks/decomposes change a waiting reason, and it is the dependent (`to`) side whose pipelineHealth goes stale, never the blocker's
  if (input.kind !== 'blocks' && input.kind !== 'decomposes') return;
  await publishPipelineHealthChanged(input.projectId, [input.toIssueId]);
}

async function maybeRunDecomposeHelper(
  input: SetIssueDependencyInput,
  ownerId: string,
): Promise<void> {
  if (input.kind !== 'decomposes') return;
  // cm:guard an explicit `useIntegrationBranch:false` must skip the helper ENTIRELY, not pass the flag down — decomposeParent still creates branches for other reasons, and callers that only model decomposition rely on this call making no git side effect at all
  if (input.decomposeOpts?.useIntegrationBranch === false) return;
  try {
    await decomposeParent(
      input.fromIssueId,
      [{ existingIssueId: input.toIssueId }],
      { userId: ownerId },
      { useIntegrationBranch: input.decomposeOpts?.useIntegrationBranch },
    );
  } catch (err) {
    // cm:guard never fail the edge write when branch creation fails — the edge is the durable record the dispatcher gates on, and a git error here would lose it
    logger.warn(
      { err, parentId: input.fromIssueId, childId: input.toIssueId },
      'setIssueDependency: decompose helper failed for decomposes edge',
    );
  }
}
