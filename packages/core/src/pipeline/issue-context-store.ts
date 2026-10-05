import { scrubSecretsDeep } from '@forge/observability';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  type IssueStepContextKind,
  issueStepContextKinds,
  issueStepContexts,
  issues,
  pipelineRuns,
  type StepVerdict,
} from '../db/schema.js';
import { actorAgencies, actorTypes } from '../db/schema-activity.js';
import { refreshModuleKnowledgeForIssue } from './ports.js';
import { refusePipeline } from './refuse.js';
import { type StepHandoffPayload, stepHandoffSchema } from './step-handoff-schema.js';

/**
 * ISS-381 (2.1) — derive the unified verdict column value from a handoff
 * payload. Review handoffs carry `verdict` (pass/needs_fix/no_change); test
 * handoffs carry `result` (pass/fail). Every other step has no verdict (null),
 * which on a re-run upsert intentionally clears any prior value.
 */
function extractVerdict(payload: StepHandoffPayload): StepVerdict | null {
  if (payload.step === 'review') return payload.verdict;
  if (payload.step === 'test') return payload.result;
  return null;
}

const PASSING_TEST_RESULTS: readonly StepVerdict[] = ['pass', 'verified_by_test'];

function isPassingTestHandoff(payload: StepHandoffPayload): boolean {
  return payload.step === 'test' && PASSING_TEST_RESULTS.includes(payload.result);
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
 * The caller authorizes the project; every writer here then proves the issue,
 * and the run it names, belong to that project, so a grant on one project
 * never reaches another project's evidence.
 */

/** The issue answers inside the project or not at all: a foreign issue reads as an unknown one. */
async function assertIssueInProject(projectId: string, issueId: string): Promise<void> {
  const [row] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId)))
    .limit(1);
  if (!row) {
    throw refusePipeline(
      'ISSUE_NOT_IN_PROJECT',
      `issue ${issueId} was not found in project ${projectId}`,
      '/issueId',
    );
  }
}

async function assertRunOfIssue(projectId: string, issueId: string, runId: string): Promise<void> {
  const [row] = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.id, runId),
        eq(pipelineRuns.projectId, projectId),
        eq(pipelineRuns.issueId, issueId),
      ),
    )
    .limit(1);
  if (!row) {
    throw refusePipeline(
      'PIPELINE_RUN_NOT_FOUND',
      `pipeline run ${runId} was not found for issue ${issueId} in project ${projectId}`,
      '/pipelineRunId',
    );
  }
}

const scopeSchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  pipelineRunId: z.uuid(),
  step: z.string().trim().min(1).max(64).optional(),
  attempt: z.number().int().positive().default(1),
});

const writeInputBaseSchema = scopeSchema.extend({
  kind: z.enum(issueStepContextKinds),
});

const writeIssueContextActorSchema = z.object({
  type: z.enum(actorTypes),
  id: z.uuid(),
  agency: z.enum(actorAgencies),
});

const writeIssueContextInputSchema = writeInputBaseSchema.extend({
  payload: stepHandoffSchema,
  actor: writeIssueContextActorSchema,
});
type WriteIssueContextInput = z.infer<typeof writeIssueContextInputSchema>;

interface WriteIssueContextResult {
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
  const parsed = writeIssueContextInputSchema.parse(input);
  const validated = { ...parsed, payload: scrubSecretsDeep(parsed.payload) };

  if (validated.kind === 'handoff') {
    if (!validated.step) {
      throw refusePipeline('ARGUMENT_REQUIRED', 'a handoff names its `step`', '/step');
    }
    if (validated.payload.step !== validated.step) {
      throw refusePipeline(
        'HANDOFF_STEP_MISMATCH',
        `payload.step is \`${validated.payload.step}\` but the handoff is written for step \`${validated.step}\`; they name the same step`,
        '/payload/step',
      );
    }
    await assertIssueInProject(validated.projectId, validated.issueId);
    await assertRunOfIssue(validated.projectId, validated.issueId, validated.pipelineRunId);
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
        target: [issueStepContexts.issueId, issueStepContexts.step, issueStepContexts.attempt],
        targetWhere: sql`${issueStepContexts.kind} = 'handoff'`,
        set: {
          projectId: sql`excluded.project_id`,
          pipelineRunId: sql`excluded.pipeline_run_id`,
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

    if (isPassingTestHandoff(validated.payload)) {
      await refreshModuleKnowledgeForIssue({
        issueId: validated.issueId,
        projectId: validated.projectId,
        actor: validated.actor,
      });
    }
    return row;
  }

  throw new Error(`writeIssueContext: kind '${validated.kind}' not implemented`);
}

const getIssueContextsInputSchema = z.object({
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
type GetIssueContextsInput = z.infer<typeof getIssueContextsInputSchema>;

interface IssueContextRow {
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

export async function getIssueContexts(input: GetIssueContextsInput): Promise<IssueContextRow[]> {
  const validated = getIssueContextsInputSchema.parse(input);
  await assertIssueInProject(validated.projectId, validated.issueId);
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

const deleteIssueContextInputSchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  kind: z.enum(issueStepContextKinds),
  step: z.string().min(1).max(64),
  attempt: z.number().int().positive(),
});
type DeleteIssueContextInput = z.infer<typeof deleteIssueContextInputSchema>;

/**
 * Idempotent delete by natural key (kind='handoff' only; other kinds use id
 * directly when added). Returns the number of removed rows (0 or 1).
 */
export async function deleteIssueContext(input: DeleteIssueContextInput): Promise<number> {
  const validated = deleteIssueContextInputSchema.parse(input);
  await assertIssueInProject(validated.projectId, validated.issueId);
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
