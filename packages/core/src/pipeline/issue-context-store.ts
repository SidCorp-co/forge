import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { actorAgencies, actorTypes } from '../db/schema-activity.js';
import { runJournal } from '../db/schema-journal.js';
import { refreshModuleKnowledgeForIssue } from '../labels/module-knowledge-refresh.js';
import { type StepHandoffPayload, stepHandoffSchema } from '../memory/step-handoff-schema.js';

/**
 * The handoff half of the run journal (ISS-1133), behind the surface `issue_step_contexts` had:
 * the `forge_step_handoff` tools and `/api/issue-step-contexts`. A handoff is the attempt's own
 * result, so it lands on the `run_journal` row of (run, step, attempt), once.
 *
 * Does NOT check authorization — callers (REST routes, MCP tool factories)
 * MUST verify project membership before invoking.
 */

export const issueStepContextKinds = ['handoff'] as const;
export type IssueStepContextKind = (typeof issueStepContextKinds)[number];

const PASSING_TEST_RESULTS: readonly string[] = ['pass', 'verified_by_test'];

function isPassingTestHandoff(payload: StepHandoffPayload): boolean {
  return payload.step === 'test' && PASSING_TEST_RESULTS.includes(payload.result);
}

const scopeSchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  pipelineRunId: z.uuid(),
  step: z.string().trim().min(1).max(64).optional(),
  attempt: z.number().int().positive().default(1),
});
/** A write named an issue that belongs to another project than the one it was authorised against. */
export class IssueNotInProject extends Error {
  constructor(issueId: string) {
    super(`issue ${issueId} does not belong to the project this write was made against`);
    this.name = 'IssueNotInProject';
  }
}

async function assertIssueInProject(issueId: string, projectId: string): Promise<void> {
  const [row] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId)))
    .limit(1);
  if (!row) throw new IssueNotInProject(issueId);
}

/** A write named a pipeline run that is not one of the project's, or does not exist at all. */
export class PipelineRunNotFound extends Error {
  constructor(runId: string) {
    super(`pipelineRunId ${runId} is not accepted: no such run exists in this project`);
    this.name = 'PipelineRunNotFound';
  }
}

/**
 * The row's foreign key refuses a run that does not exist, as a bare database error; a run of
 * another project would pass it, so the run is read inside the project, and a miss reads the same
 * for both so the answer never says whether a run exists elsewhere.
 */
async function assertRunInProject(runId: string, projectId: string): Promise<void> {
  const [row] = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.projectId, projectId)))
    .limit(1);
  if (!row) throw new PipelineRunNotFound(runId);
}

/** Why a handoff was not written: the attempt already holds one, or belongs to another issue.
 *  The row is left as it was in both. */
export class HandoffRefused extends Error {
  constructor(
    readonly code: 'HANDOFF_ALREADY_WRITTEN' | 'HANDOFF_NOT_THIS_ISSUE',
    message: string,
  ) {
    super(message);
    this.name = 'HandoffRefused';
  }
}

/** A handoff delete: the journal keeps every attempt, so there is nothing a delete may remove. */
export class HandoffDeleteRefused extends Error {
  readonly code = 'HANDOFF_IS_JOURNAL';
  constructor(step: string, attempt: number) {
    super(
      `the \`${step}\` handoff of attempt ${attempt} was not deleted: a handoff is the run journal's ` +
        "record of that attempt and the journal keeps every attempt. A later round is a new attempt's handoff",
    );
    this.name = 'HandoffDeleteRefused';
  }
}

export type IssueContextScope = z.infer<typeof scopeSchema>;

const writeInputBaseSchema = scopeSchema.extend({
  kind: z.enum(issueStepContextKinds),
});

const writeIssueContextActorSchema = z.object({
  type: z.enum(actorTypes),
  id: z.uuid(),
  agency: z.enum(actorAgencies),
});

export const writeIssueContextInputSchema = writeInputBaseSchema.extend({
  payload: stepHandoffSchema,
  actor: writeIssueContextActorSchema,
});
export type WriteIssueContextInput = z.infer<typeof writeIssueContextInputSchema>;

export interface WriteIssueContextResult {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Write the handoff of the attempt `(pipelineRunId, step, attempt)`. Where the run declared that
 * phase attempt, the handoff fills its row; where it never did, a closed row is appended for it.
 * A second handoff for the same attempt is refused by name and the first stands.
 */
export async function writeIssueContext(
  input: WriteIssueContextInput,
): Promise<WriteIssueContextResult> {
  const validated = writeIssueContextInputSchema.parse(input);
  await assertIssueInProject(validated.issueId, validated.projectId);
  await assertRunInProject(validated.pipelineRunId, validated.projectId);

  if (validated.kind !== 'handoff') {
    throw new Error(`writeIssueContext: kind '${validated.kind}' not implemented`);
  }
  const step = validated.step;
  if (!step) throw new Error('writeIssueContext: kind=handoff requires `step`');
  if (validated.payload.step !== step) {
    throw new Error(
      `writeIssueContext: payload.step (${validated.payload.step}) does not match scope.step (${step})`,
    );
  }

  const attemptOf = and(
    eq(runJournal.runId, validated.pipelineRunId),
    eq(runJournal.phase, step),
    eq(runJournal.attempt, validated.attempt),
  );
  const now = new Date();
  const [filled] = await db
    .update(runJournal)
    .set({ handoff: validated.payload, handoffAt: now, issueId: validated.issueId })
    .where(
      and(
        attemptOf,
        isNull(runJournal.handoff),
        or(isNull(runJournal.issueId), eq(runJournal.issueId, validated.issueId)),
      ),
    )
    .returning({ id: runJournal.id, startedAt: runJournal.startedAt, at: runJournal.handoffAt });
  const written =
    filled ??
    (
      await db
        .insert(runJournal)
        .values({
          projectId: validated.projectId,
          runId: validated.pipelineRunId,
          issueId: validated.issueId,
          phase: step,
          attempt: validated.attempt,
          source: 'agent',
          outcome: 'ok',
          handoff: validated.payload,
          handoffAt: now,
          startedAt: now,
          endedAt: now,
        })
        .onConflictDoNothing({
          target: [runJournal.runId, runJournal.phase, runJournal.attempt],
        })
        .returning({ id: runJournal.id, startedAt: runJournal.startedAt, at: runJournal.handoffAt })
    )[0];
  if (!written) await refuseHeldAttempt(validated.pipelineRunId, step, validated.attempt);
  const row = written as NonNullable<typeof written>;

  if (isPassingTestHandoff(validated.payload)) {
    await refreshModuleKnowledgeForIssue({
      issueId: validated.issueId,
      projectId: validated.projectId,
      actor: validated.actor,
    });
  }
  const at = row.at ?? now;
  return { id: row.id, createdAt: at, updatedAt: at };
}

/** The attempt exists and took no handoff: say which of the two reasons it was. */
async function refuseHeldAttempt(runId: string, step: string, attempt: number): Promise<never> {
  const [held] = await db
    .select({ issueId: runJournal.issueId, handoffAt: runJournal.handoffAt })
    .from(runJournal)
    .where(
      and(eq(runJournal.runId, runId), eq(runJournal.phase, step), eq(runJournal.attempt, attempt)),
    )
    .limit(1);
  const named = `the \`${step}\` attempt ${attempt} of run ${runId}`;
  if (held?.handoffAt) {
    throw new HandoffRefused(
      'HANDOFF_ALREADY_WRITTEN',
      `${named} already holds its handoff, written ${held.handoffAt.toISOString()}; the journal keeps the first and this one was not written. A later round is a new attempt`,
    );
  }
  throw new HandoffRefused(
    'HANDOFF_NOT_THIS_ISSUE',
    `${named} belongs to issue ${held?.issueId ?? 'another issue'}, not the one this handoff names; nothing was written`,
  );
}

export const getIssueContextsInputSchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  /** Optional kind filter — when omitted, all kinds are returned. */
  kind: z.enum(issueStepContextKinds).optional(),
  /** Optional step allow-list — only rows whose `step` is in this list match. */
  steps: z.array(z.string().min(1).max(64)).max(20).optional(),
  /** Optional pipeline_run scope, so a prefetch never injects a prior run's handoffs. */
  pipelineRunId: z.uuid().optional(),
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
  payload: StepHandoffPayload;
  createdAt: Date;
  updatedAt: Date;
}

/** An issue's handoffs, in the shape the handoff surface has always answered with. */
export async function getIssueContexts(input: GetIssueContextsInput): Promise<IssueContextRow[]> {
  const validated = getIssueContextsInputSchema.parse(input);
  const conds = [
    eq(runJournal.projectId, validated.projectId),
    eq(runJournal.issueId, validated.issueId),
    isNotNull(runJournal.handoff),
  ];
  if (validated.pipelineRunId) conds.push(eq(runJournal.runId, validated.pipelineRunId));
  if (validated.steps && validated.steps.length > 0) {
    conds.push(inArray(runJournal.phase, validated.steps));
  }
  const orderFn = validated.orderDir === 'asc' ? asc : desc;
  const rows = await db
    .select()
    .from(runJournal)
    .where(and(...conds))
    .orderBy(orderFn(runJournal.handoffAt))
    .limit(validated.limit);

  return rows.map((r) => {
    const at = r.handoffAt ?? r.startedAt;
    return {
      id: r.id,
      projectId: r.projectId,
      issueId: validated.issueId,
      pipelineRunId: r.runId,
      kind: 'handoff' as const,
      step: r.phase,
      attempt: r.attempt,
      payload: r.handoff as StepHandoffPayload,
      createdAt: at,
      updatedAt: at,
    };
  });
}

export const deleteIssueContextInputSchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  kind: z.enum(issueStepContextKinds),
  step: z.string().min(1).max(64),
  attempt: z.number().int().positive(),
});
export type DeleteIssueContextInput = z.infer<typeof deleteIssueContextInputSchema>;

/** Refused by name, always: the journal keeps every attempt's handoff. */
export async function deleteIssueContext(input: DeleteIssueContextInput): Promise<never> {
  const validated = deleteIssueContextInputSchema.parse(input);
  throw new HandoffDeleteRefused(validated.step, validated.attempt);
}
