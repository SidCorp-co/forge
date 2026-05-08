import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { issueDependencies, issueDependencyKinds, issues } from '../../db/schema.js';
import { detectCycle } from '../../issues/dependency-routes.js';
import { safeRecordActivity } from '../../pipeline/activity.js';
import { hooks } from '../../pipeline/hooks.js';
import {
  type DeviceScopedMcpToolFactory,
  assertPmActor,
  zodToMcpSchema,
} from './lib.js';

/**
 * `forge_pm.set_dependency` (Epic 3, ISS-19) — record a dependency edge
 * between two issues in the same project. Idempotent on the unique edge
 * `(project_id, from_issue_id, to_issue_id, kind)` from Epic 1; duplicates
 * return the existing row with `created: false`.
 *
 * Epic 4 (ISS-20) wires the `dependencyChanged` hook emit on first insert so
 * PM spawn triggers react to graph mutations.
 */

const inputSchema = z
  .object({
    projectId: z.uuid(),
    fromIssueId: z.uuid(),
    toIssueId: z.uuid(),
    kind: z.enum(issueDependencyKinds),
    reason: z.string().max(2000).optional(),
    validUntil: z.iso.datetime().optional(),
  })
  .strict();

export const forgePmSetDependencyTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_pm.set_dependency',
  description:
    "Record a dependency edge (blocks/relates/duplicates/parent) between two issues in the same project. Idempotent. Requires PM-actor capability. Dispatcher convention (ISS-40 PR-E): only `kind='blocks'` rows gate dispatch — `(from=A, to=B, kind='blocks')` means A must reach a terminal status (released/closed/pipeline_failed) before B can dispatch. For `blocks` edges, cycles are rejected with a CYCLE_DETECTED error.",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertPmActor(device, input.projectId);

    if (input.fromIssueId === input.toIssueId) {
      throw new Error('BAD_REQUEST: self-edge not allowed');
    }

    const sides = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(inArray(issues.id, [input.fromIssueId, input.toIssueId]));
    if (sides.length !== 2) {
      throw new Error('NOT_FOUND: one or both issues not found');
    }
    for (const s of sides) {
      if (s.projectId !== input.projectId) {
        throw new Error('BAD_REQUEST: both issues must belong to projectId');
      }
    }

    // ISS-40 PR-E — only `blocks` edges gate dispatch, so they're the only
    // ones that can deadlock the dispatcher. Cycle-check before insert.
    if (input.kind === 'blocks') {
      const cycle = await detectCycle(input.toIssueId, input.fromIssueId);
      if (cycle === 'cycle') {
        throw new Error('CYCLE_DETECTED: adding this blocks edge would form a loop');
      }
      if (cycle === 'depth_exceeded') {
        throw new Error('CYCLE_DEPTH_EXCEEDED: dependency graph exceeds detection depth');
      }
    }

    const inserted = await db
      .insert(issueDependencies)
      .values({
        projectId: input.projectId,
        fromIssueId: input.fromIssueId,
        toIssueId: input.toIssueId,
        kind: input.kind,
        reason: input.reason ?? null,
        createdById: device.ownerId,
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
      if (!id) throw new Error('forge_pm.set_dependency: insert returned no row');
      await hooks.emit('dependencyChanged', {
        projectId: input.projectId,
        edgeId: id,
        fromIssueId: input.fromIssueId,
        toIssueId: input.toIssueId,
        kind: input.kind,
      });
      const dependencyPayload: Record<string, unknown> = {
        edgeId: id,
        fromIssueId: input.fromIssueId,
        toIssueId: input.toIssueId,
        kind: input.kind,
        ...(input.reason ? { reason: input.reason } : {}),
      };
      const actor = { type: 'device' as const, id: device.id };
      await Promise.all([
        safeRecordActivity({
          issueId: input.fromIssueId,
          actor,
          action: 'issue.dependency.added',
          payload: dependencyPayload,
        }),
        safeRecordActivity({
          issueId: input.toIssueId,
          actor,
          action: 'issue.dependency.added',
          payload: dependencyPayload,
        }),
      ]);
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
    if (!existing) {
      throw new Error('forge_pm.set_dependency: conflict but no existing row found');
    }
    return { id: existing.id, created: false };
  },
});
