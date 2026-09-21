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

export type IssueRelationInput = {
  kind: 'blocks' | 'relates';
  dependsOnId?: string | undefined;
  blocksId?: string | undefined;
  reason?: string | undefined;
  validUntil?: string | undefined;
};

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
export async function writeIssueRelations(
  writer: IssueDependencyWriter,
  projectId: string,
  issueId: string,
  relations: readonly IssueRelationInput[] | undefined,
  ex: IssueDependencyExecutor,
): Promise<PendingIssueRelation[]> {
  const pending: PendingIssueRelation[] = [];
  for (const rel of relations ?? []) {
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
