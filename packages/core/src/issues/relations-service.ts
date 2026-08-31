/**
 * ISS-571 / ISS-868 — the `relations` a caller declares relative to the issue
 * being created or updated, mapped onto the graph's `from`/`to` shape.
 *
 * ISS-889 — moved out of `mcp/tools/` so the create path can reach it without
 * an `issues → mcp` import. It is transport-neutral: callers hand it the
 * writer identity they already resolved.
 */

import { z } from 'zod';
import { db } from '../db/client.js';
import type { IssueDependencyExecutor } from './dependency-executor.js';
import {
  emitIssueDependencyEffects,
  type IssueDependencyWrite,
  type IssueDependencyWriter,
  type SetIssueDependencyInput,
  writeIssueDependency,
} from './dependency-service.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';

/**
 * One entry of `relations`, expressed relative to the issue being created or
 * updated.
 */
export type IssueRelationInput = {
  kind: 'blocks' | 'relates';
  dependsOnId?: string | undefined;
  blocksId?: string | undefined;
  reason?: string | undefined;
  validUntil?: string | undefined;
};

// cm:guard NEVER widen this to `decomposes` — that kind runs decomposeParent, which creates an integration branch and parks the parent, and this list is what BOTH the PAT-reachable MCP write path (ISS-868) and REST create accept, so adding it would put runner-shaped side effects behind credential classes the device gate exists to keep out of them. `duplicates`/`parent` are excluded only because they carry no side effect worth an atomic write; route both through forge_project_pm set_dependency.
export const RELATION_KINDS = ['blocks', 'relates'] as const;

/**
 * The wire shape of one `relations` entry, shared by every transport that
 * accepts them so the exactly-one-side rule is stated once.
 */
export const issueRelationInputSchema = z
  .object({
    kind: z.enum(RELATION_KINDS).default('blocks'),
    dependsOnId: z.uuid().optional(),
    blocksId: z.uuid().optional(),
    reason: z.string().max(2000).optional(),
    validUntil: z.iso.datetime().optional(),
  })
  .strict()
  .refine((r) => (r.dependsOnId == null) !== (r.blocksId == null), {
    message: 'each relation must set exactly one of dependsOnId or blocksId',
  });

export type AppliedIssueRelation = {
  edgeId: string;
  kind: 'blocks' | 'relates';
  fromIssueId: string;
  toIssueId: string;
  created: boolean;
  updated: boolean;
};

// cm:guard `dependsOnId` puts the OTHER issue on the `from` side and this one on `to` — the repo's convention is `from` BLOCKS `to`, so swapping the two silently inverts every edge an agent declares and the dispatcher gates the wrong side
// cm:edge contract -> packages/core/src/issues/dependency-routes.ts — same direction as POST /api/issues/:id/dependencies, whose `dependsOnId` also lands as (from=dependsOnId, to=:id)
export async function applyIssueRelations(
  writer: IssueDependencyWriter,
  projectId: string,
  issueId: string,
  relations: readonly IssueRelationInput[] | undefined,
): Promise<AppliedIssueRelation[]> {
  const pending = await writeIssueRelations(writer, projectId, issueId, relations, db);
  await flushIssueRelationEffects(writer, projectId, pending);
  return pending.map((p) => p.applied);
}

/** One edge landed, plus what announcing it will need. */
export type PendingIssueRelation = {
  applied: AppliedIssueRelation;
  input: SetIssueDependencyInput;
  written: IssueDependencyWrite;
};

/**
 * The DURABLE half of `relations`: land every edge on `ex`, announce none.
 * A create passes its open transaction so the issue and its edges commit as
 * one, then flushes the effects.
 */
// cm:guard keep this loop SEQUENTIAL — `writeIssueDependency` runs `detectCycle` on the SAME executor, so A→B and B→A sent in one `relations` array are each individually acyclic and only the serial order rejects the pair; `onConflictDoNothing` does not catch a cycle. A `Promise.all` here reads like an obvious win and admits the cycle the gate exists to refuse.
export async function writeIssueRelations(
  writer: IssueDependencyWriter,
  projectId: string,
  issueId: string,
  relations: readonly IssueRelationInput[] | undefined,
  ex: IssueDependencyExecutor,
): Promise<PendingIssueRelation[]> {
  const pending: PendingIssueRelation[] = [];
  for (const rel of relations ?? []) {
    // cm:guard enforce EXACTLY one side here, not just "at least one" — the zod `.refine` in forge-issues.ts is the only other check, so a second caller of this helper (or a widened schema) would otherwise get the `dependsOnId` branch silently and lose the `blocksId` edge it also asked for
    if ((rel.dependsOnId == null) === (rel.blocksId == null)) {
      throw new Error('BAD_REQUEST: relation needs exactly one of dependsOnId or blocksId');
    }
    const fromIssueId = rel.dependsOnId ?? issueId;
    const toIssueId = rel.dependsOnId != null ? issueId : rel.blocksId;
    if (!toIssueId) throw new Error('BAD_REQUEST: relation needs dependsOnId or blocksId');
    const input: SetIssueDependencyInput = {
      projectId,
      fromIssueId,
      toIssueId,
      kind: rel.kind,
      reason: rel.reason,
      validUntil: rel.validUntil,
    };
    const written = await writeIssueDependency(input, writer, ex);
    pending.push({
      input,
      written,
      applied: {
        edgeId: written.id,
        kind: rel.kind,
        fromIssueId,
        toIssueId,
        created: written.created,
        updated: written.updated,
      },
    });
  }
  return pending;
}

/**
 * The EFFECTS half: announce every edge the write landed, then publish the
 * dependents' health once for the whole array.
 */
// cm:guard ONE publish for the whole array, not one per edge — `publishPipelineHealthChanged` fans out to `hydratePipelineHealthForIssues`, which is ~9 sequential round trips, and it already batches by `inArray(ids)`; per-edge publishing cost 9N reads for the schema's 20-edge maximum. It must still run HERE, before the caller's `issueCreated` emit / status transition wakes the dispatcher.
export async function flushIssueRelationEffects(
  writer: IssueDependencyWriter,
  projectId: string,
  pending: readonly PendingIssueRelation[],
): Promise<void> {
  const refreshHealthFor: string[] = [];
  for (const p of pending) {
    await emitIssueDependencyEffects(p.input, p.written, writer, { deferHealthPublish: true });
    if (p.applied.kind === 'blocks' && (p.applied.created || p.applied.updated)) {
      refreshHealthFor.push(p.applied.toIssueId);
    }
  }
  if (refreshHealthFor.length > 0) {
    await publishPipelineHealthChanged(projectId, refreshHealthFor);
  }
}
