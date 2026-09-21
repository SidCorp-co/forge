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
import { type Actor, safeRecordActivity } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { detectCycle } from './cycle-detect.js';
import { type DependencyKindEffect, describeDependencyKind } from './dependency-effects.js';
import type { IssueDependencyExecutor } from './dependency-executor.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';

export type IssueDependencyKind = (typeof issueDependencyKinds)[number];

export type IssueDependencyErrorCode =
  | 'SELF_DEP'
  | 'NOT_FOUND'
  | 'CROSS_PROJECT'
  | 'CYCLE_DETECTED'
  | 'CYCLE_DEPTH_EXCEEDED'
  | 'INTERNAL';

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
};

/**
 * Who the write is attributed to. `createdById` lands in the row; `actor` is
 * what the activity log records.
 */
export type IssueDependencyWriter = {
  actor: Actor;
  createdById: string;
};

/** True when this write only retires the edge: `validUntil` already in the past. */
const expiresEdge = (validUntil: string | undefined): boolean =>
  validUntil !== undefined && new Date(validUntil).getTime() <= Date.now();

export type SetIssueDependencyResult = {
  id: string;
  created: boolean;
  updated?: boolean;
  /** What the edge just written actually does — a caller cannot read it off `kind`. */
  effects: DependencyKindEffect;
};

/** What the durable half landed, and which announcement it owes. */
export type IssueDependencyWrite = {
  id: string;
  created: boolean;
  updated: boolean;
  /** `null` when a bare re-assert changed nothing — there is nothing to announce. */
  effect: 'added' | 'updated' | null;
};

/**
 * Idempotent on the unique edge `(project_id, from_issue_id, to_issue_id, kind)`.
 * A duplicate returns `created:false` and applies whichever of `validUntil` /
 * `reason` the caller supplied, reporting that as `updated`. Setting
 * `validUntil` into the past is how an edge is RETRACTED.
 */
export async function setIssueDependency(
  input: SetIssueDependencyInput,
  writer: IssueDependencyWriter,
  opts?: { deferHealthPublish?: boolean },
): Promise<SetIssueDependencyResult> {
  const written = await writeIssueDependency(input, writer);
  await emitIssueDependencyEffects(input, written, writer, opts);
  const effects = describeDependencyKind(input.kind);
  if (written.created) return { id: written.id, created: true, effects };
  return { id: written.id, created: false, updated: written.updated, effects };
}

/**
 * The DURABLE half: validate, detect a cycle, and land the row. Runs on the
 * caller's executor so a create can commit the issue and its edge together.
 */
export async function writeIssueDependency(
  input: SetIssueDependencyInput,
  writer: IssueDependencyWriter,
  ex: IssueDependencyExecutor = db,
): Promise<IssueDependencyWrite> {
  if (input.fromIssueId === input.toIssueId) {
    throw new IssueDependencyError('SELF_DEP');
  }

  const sides = await ex
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, [input.fromIssueId, input.toIssueId]));
  if (sides.length !== 2) throw new IssueDependencyError('NOT_FOUND');
  for (const s of sides) {
    if (s.projectId !== input.projectId) throw new IssueDependencyError('CROSS_PROJECT');
  }

  if (input.kind === 'blocks' && !expiresEdge(input.validUntil)) {
    const cycle = await detectCycle(input.toIssueId, input.fromIssueId, ex);
    if (cycle === 'cycle') throw new IssueDependencyError('CYCLE_DETECTED');
    if (cycle === 'depth_exceeded') throw new IssueDependencyError('CYCLE_DEPTH_EXCEEDED');
  }

  const inserted = await ex
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
    return { id, created: true, updated: false, effect: 'added' };
  }

  const [existing] = await ex
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

  const patch: { validUntil?: Date; reason?: string } = {};
  if (input.validUntil) patch.validUntil = new Date(input.validUntil);
  if (input.reason) patch.reason = input.reason;
  const updated = Object.keys(patch).length > 0;

  if (updated) {
    await ex.update(issueDependencies).set(patch).where(eq(issueDependencies.id, existing.id));
  }

  return { id: existing.id, created: false, updated, effect: updated ? 'updated' : null };
}

/**
 * The EFFECTS half: announce the edge and refresh the dependent's health.
 * Runs after the write has committed.
 */
export async function emitIssueDependencyEffects(
  input: SetIssueDependencyInput,
  written: IssueDependencyWrite,
  writer: IssueDependencyWriter,
  opts?: { deferHealthPublish?: boolean },
): Promise<void> {
  if (written.effect === 'added') {
    await emitEdgeChanged(input, written.id);
    await recordOnBothSides(input, written.id, writer.actor, 'issue.dependency.added', {
      ...(input.reason ? { reason: input.reason } : {}),
    });
    await refreshDependentHealth(input, opts);
    return;
  }

  if (written.effect === 'updated') {
    await emitEdgeChanged(input, written.id);
    await recordOnBothSides(input, written.id, writer.actor, 'issue.dependency.updated', {
      ...(input.validUntil ? { validUntil: input.validUntil } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    await refreshDependentHealth(input, opts);
  }
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

async function refreshDependentHealth(
  input: SetIssueDependencyInput,
  opts?: { deferHealthPublish?: boolean },
): Promise<void> {
  if (opts?.deferHealthPublish) return;
  if (input.kind !== 'blocks') return;
  await publishPipelineHealthChanged(input.projectId, [input.toIssueId]);
}
