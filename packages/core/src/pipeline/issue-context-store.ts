import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  type IssueStepContextKind,
  type StepVerdict,
  issueStepContextKinds,
  issueStepContexts,
} from '../db/schema.js';
import {
  type StepHandoffPayload,
  stepHandoffSchema,
} from '../memory/step-handoff-schema.js';

/**
 * ISS-381 (2.1) — derive the unified verdict column value from a handoff
 * payload. Review handoffs carry `verdict` (pass/needs_fix/no_change); test
 * handoffs carry `result` (pass/fail). Every other step has no verdict (null),
 * which on a re-run upsert intentionally clears any prior value.
 */
export function extractVerdict(payload: StepHandoffPayload): StepVerdict | null {
  if (payload.step === 'review') return payload.verdict;
  if (payload.step === 'test') return payload.result;
  return null;
}

/**
 * Repository for `issue_step_contexts` — per-issue per-pipeline-run structured
 * context (proposal Y).
 *
 * Generic write/get over `kind`; v1 only persists kind='handoff' (validated
 * against `stepHandoffSchema`). Future kinds (blocker_note, retrospective,
 * cross_step_decision) plug in here by extending the dispatcher in
 * `writeIssueContext` — the table schema does not change.
 *
 * Does NOT check authorization — callers (REST routes, MCP tool factories)
 * MUST verify project membership before invoking.
 */

const scopeSchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  pipelineRunId: z.uuid(),
  step: z.string().trim().min(1).max(64).optional(),
  attempt: z.number().int().positive().default(1),
});
export type IssueContextScope = z.infer<typeof scopeSchema>;

// Discriminated dispatch on kind so each kind validates its own payload.
const writeInputBaseSchema = scopeSchema.extend({
  kind: z.enum(issueStepContextKinds),
});

export const writeIssueContextInputSchema = writeInputBaseSchema.extend({
  // Payload union — extend the .or() chain when new kinds land.
  payload: stepHandoffSchema,
});
export type WriteIssueContextInput = z.infer<typeof writeIssueContextInputSchema>;

export interface WriteIssueContextResult {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Upsert an issue-step-context row. For `kind='handoff'` the natural key is
 * `(issueId, step, attempt)`; conflicting writes replace the payload + bump
 * `updatedAt` so re-runs of the same attempt land cleanly.
 *
 * For non-handoff kinds (future), upsert is by `id` only — caller chooses
 * whether to insert fresh or pre-resolve an id to update.
 */
export async function writeIssueContext(
  input: WriteIssueContextInput,
): Promise<WriteIssueContextResult> {
  const validated = writeIssueContextInputSchema.parse(input);

  if (validated.kind === 'handoff') {
    if (!validated.step) {
      throw new Error('writeIssueContext: kind=handoff requires `step`');
    }
    // Cross-validate the discriminator: payload.step must match the
    // outer scope.step. Catches drift between scope literal and payload
    // shape (otherwise an agent could submit a triage payload under a
    // plan slot and silently corrupt downstream reads).
    if (validated.payload.step !== validated.step) {
      throw new Error(
        `writeIssueContext: payload.step (${validated.payload.step}) does not match scope.step (${validated.step})`,
      );
    }
    // ISS-381 (2.1) — promote the structured verdict out of the payload so it is
    // aggregate-queryable. Written for every step (null for non-review/test) so a
    // corrected re-run of the same attempt clears a stale value rather than
    // leaving a phantom verdict.
    const verdict = extractVerdict(validated.payload);
    const [row] = await db
      .insert(issueStepContexts)
      .values({
        projectId: validated.projectId,
        issueId: validated.issueId,
        pipelineRunId: validated.pipelineRunId,
        kind: 'handoff',
        step: validated.step,
        attempt: validated.attempt,
        payload: validated.payload,
        verdict,
      })
      .onConflictDoUpdate({
        // Match the partial unique index defined in db/schema.ts. Drizzle
        // does not surface partial-unique targets directly; this works
        // because Postgres resolves the conflict by index when target
        // columns match the unique index's columns.
        target: [issueStepContexts.issueId, issueStepContexts.step, issueStepContexts.attempt],
        targetWhere: sql`${issueStepContexts.kind} = 'handoff'`,
        set: {
          payload: sql`excluded.payload`,
          verdict: sql`excluded.verdict`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: issueStepContexts.id,
        createdAt: issueStepContexts.createdAt,
        updatedAt: issueStepContexts.updatedAt,
      });
    if (!row) throw new Error('writeIssueContext: upsert returned no row');
    return row;
  }

  // Unreachable for v1 (only 'handoff' in IssueStepContextKind union), but
  // keeps the fall-through explicit when future kinds extend the enum.
  throw new Error(`writeIssueContext: kind '${validated.kind}' not implemented`);
}

export const getIssueContextsInputSchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  /** Optional kind filter — when omitted, all kinds are returned. */
  kind: z.enum(issueStepContextKinds).optional(),
  /** Optional step allow-list — only rows whose `step` is in this list match. */
  steps: z.array(z.string().min(1).max(64)).max(20).optional(),
  /**
   * Optional pipeline_run scope. When set, rows are limited to that run —
   * dispatcher prefetch passes the current run so we never inject handoffs
   * from a prior (cancelled / superseded) run.
   */
  pipelineRunId: z.uuid().optional(),
  /**
   * Pagination + ordering. Defaults: latest-first by createdAt, 50 rows.
   */
  limit: z.number().int().min(1).max(200).default(50),
  orderDir: z.enum(['asc', 'desc']).default('desc'),
});
export type GetIssueContextsInput = z.infer<typeof getIssueContextsInputSchema>;

export interface IssueContextRow {
  id: string;
  projectId: string;
  issueId: string;
  pipelineRunId: string;
  kind: IssueStepContextKind;
  step: string | null;
  attempt: number;
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export async function getIssueContexts(
  input: GetIssueContextsInput,
): Promise<IssueContextRow[]> {
  const validated = getIssueContextsInputSchema.parse(input);
  const conds = [
    eq(issueStepContexts.projectId, validated.projectId),
    eq(issueStepContexts.issueId, validated.issueId),
  ];
  if (validated.kind) conds.push(eq(issueStepContexts.kind, validated.kind));
  if (validated.pipelineRunId) {
    conds.push(eq(issueStepContexts.pipelineRunId, validated.pipelineRunId));
  }
  if (validated.steps && validated.steps.length > 0) {
    conds.push(inArray(issueStepContexts.step, validated.steps));
  }

  const orderFn = validated.orderDir === 'asc' ? asc : desc;

  const rows = await db
    .select()
    .from(issueStepContexts)
    .where(and(...conds))
    .orderBy(orderFn(issueStepContexts.createdAt))
    .limit(validated.limit);

  return rows.map((r) => ({
    ...r,
    kind: r.kind as IssueStepContextKind,
    payload: r.payload as StepHandoffPayload,
  }));
}

export const deleteIssueContextInputSchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  kind: z.enum(issueStepContextKinds),
  step: z.string().min(1).max(64),
  attempt: z.number().int().positive(),
});
export type DeleteIssueContextInput = z.infer<typeof deleteIssueContextInputSchema>;

/**
 * Idempotent delete by natural key (kind='handoff' only; other kinds use id
 * directly when added). Returns the number of removed rows (0 or 1).
 */
export async function deleteIssueContext(input: DeleteIssueContextInput): Promise<number> {
  const validated = deleteIssueContextInputSchema.parse(input);
  const result = await db
    .delete(issueStepContexts)
    .where(
      and(
        eq(issueStepContexts.projectId, validated.projectId),
        eq(issueStepContexts.issueId, validated.issueId),
        eq(issueStepContexts.kind, validated.kind),
        eq(issueStepContexts.step, validated.step),
        eq(issueStepContexts.attempt, validated.attempt),
      ),
    )
    .returning({ id: issueStepContexts.id });
  return result.length;
}
