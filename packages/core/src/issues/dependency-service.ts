/**
 * The one edge-write path for `issue_dependencies`: the dependency routes and a create's
 * `relations` both write through it. Authorization stays at the route; this module owns the domain
 * rules and refuses them in the envelope.
 */

import type { DependencyRefusalCode } from '@forge/contracts/issues';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueDependencies, type issueDependencyKinds, issues } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { consume, emitEvent } from '../outbox/index.js';
import { type Actor, recordActivityTx } from './activity.js';
import { archivedAmong } from './archive.js';
import { detectCycle } from './cycle-detect.js';
import { type DependencyKindEffect, describeDependencyKind } from './dependency-effects.js';
import type { IssueDependencyExecutor } from './dependency-executor.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';

export type IssueDependencyKind = (typeof issueDependencyKinds)[number];

const refuse = refuser<DependencyRefusalCode>('DEPENDENCY_REFUSED');

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

/** The edge this write names, by its unique key, or `undefined` where none exists yet. */
async function findEdge(
  ex: IssueDependencyExecutor,
  input: SetIssueDependencyInput,
): Promise<{ id: string } | undefined> {
  const [edge] = await ex
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
  return edge;
}

/** True when this write only retires the edge: `validUntil` already in the past. */
const expiresEdge = (validUntil: string | undefined): boolean =>
  validUntil !== undefined && new Date(validUntil).getTime() <= Date.now();

type SetIssueDependencyResult = {
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
): Promise<SetIssueDependencyResult> {
  // One transaction, so the `FOR SHARE` read of both sides holds until the edge commits.
  const written = await db.transaction((tx) => writeIssueDependency(input, writer, tx));
  const effects = describeDependencyKind(input.kind);
  if (written.created) return { id: written.id, created: true, effects };
  return { id: written.id, created: false, updated: written.updated, effects };
}

/**
 * Validate, detect a cycle, land the row, and write its activity and its
 * `issue.dependency.changed` event with it. Runs on the caller's executor so a
 * create can commit the issue and its edge together.
 */
export async function writeIssueDependency(
  input: SetIssueDependencyInput,
  writer: IssueDependencyWriter,
  ex: IssueDependencyExecutor,
): Promise<IssueDependencyWrite> {
  if (input.fromIssueId === input.toIssueId) {
    throw refuse('SELF_DEP', 'an issue cannot depend on itself: name two different issues');
  }

  const sides = await ex
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, [input.fromIssueId, input.toIssueId]));
  if (sides.length !== 2) throw notFound('one or both issues not found');
  for (const s of sides) {
    if (s.projectId !== input.projectId)
      throw refuse(
        'CROSS_PROJECT',
        'both issues of an edge are in this project; cross-project edges are not supported',
      );
  }
  // ISS-1237 — an edge naming an archived issue would point at a row no reader can find. The
  // `FOR SHARE` read waits on an archive holding either side, then reads what it committed. Only
  // retiring an edge that already exists passes; an edge first written already expired is new.
  const [archived] = await archivedAmong(ex, [input.fromIssueId, input.toIssueId], 'share');
  if (archived && !(expiresEdge(input.validUntil) && (await findEdge(ex, input)))) {
    throw refuse('ISSUE_ARCHIVED', archived.message);
  }

  if (input.kind === 'blocks' && !expiresEdge(input.validUntil)) {
    const cycle = await detectCycle(input.toIssueId, input.fromIssueId, ex);
    if (cycle === 'cycle')
      throw refuse('CYCLE_DETECTED', 'cycle detected — adding this edge would form a loop');
    if (cycle === 'depth_exceeded')
      throw refuse(
        'CYCLE_DEPTH_EXCEEDED',
        'cycle detection depth exceeded; the chain behind this edge is too deep to check',
      );
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
    if (!id) throw new Error('issue dependency insert returned no id');
    await recordOnBothSides(ex, input, id, writer.actor, 'issue.dependency.added', {
      ...(input.reason ? { reason: input.reason } : {}),
    });
    await emitEdgeChanged(ex, input, 'added');
    return { id, created: true, updated: false, effect: 'added' };
  }

  const existing = await findEdge(ex, input);
  if (!existing) throw new Error('issue dependency conflicted on insert but no edge was found');

  const patch: { validUntil?: Date; reason?: string } = {};
  if (input.validUntil) patch.validUntil = new Date(input.validUntil);
  if (input.reason) patch.reason = input.reason;
  const updated = Object.keys(patch).length > 0;

  if (updated) {
    await ex.update(issueDependencies).set(patch).where(eq(issueDependencies.id, existing.id));
    await recordOnBothSides(ex, input, existing.id, writer.actor, 'issue.dependency.updated', {
      ...(input.validUntil ? { validUntil: input.validUntil } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    await emitEdgeChanged(ex, input, 'updated');
  }

  return { id: existing.id, created: false, updated, effect: updated ? 'updated' : null };
}

async function recordOnBothSides(
  ex: IssueDependencyExecutor,
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
  for (const issueId of [input.fromIssueId, input.toIssueId]) {
    await recordActivityTx(ex, { issueId, actor, action, payload });
  }
}

function emitEdgeChanged(
  tx: IssueDependencyExecutor,
  edge: { projectId: string; fromIssueId: string; toIssueId: string; kind: IssueDependencyKind },
  change: 'added' | 'updated' | 'removed',
): Promise<void> {
  return emitEvent(tx, 'issue.dependency.changed', {
    projectId: edge.projectId,
    fromIssueId: edge.fromIssueId,
    toIssueId: edge.toIssueId,
    kind: edge.kind,
    change,
  });
}

/** A blocks edge that moved changes whether its dependent can run, so its health is published again. */
export function registerDependencyHealth(): void {
  consume('issue.dependency.changed', {
    name: 'dependency-health',
    handle: async (p) => {
      if (p.kind !== 'blocks') return;
      await publishPipelineHealthChanged(p.projectId, [p.toIssueId]);
    },
  });
}

/** Removes one dependency edge. */
export async function deleteIssueDependency(
  edge: {
    id: string;
    projectId: string;
    fromIssueId: string;
    toIssueId: string;
    kind: IssueDependencyKind;
  },
  actor: Actor,
): Promise<void> {
  const payload = {
    edgeId: edge.id,
    fromIssueId: edge.fromIssueId,
    toIssueId: edge.toIssueId,
    kind: edge.kind,
  };
  await db.transaction(async (tx) => {
    await tx.delete(issueDependencies).where(eq(issueDependencies.id, edge.id));
    for (const issueId of [edge.fromIssueId, edge.toIssueId]) {
      await recordActivityTx(tx, { issueId, actor, action: 'issue.dependency.removed', payload });
    }
    await emitEdgeChanged(tx, edge, 'removed');
  });
}
