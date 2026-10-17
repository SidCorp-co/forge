/**
 * The decision a held release waits on, and the one typed reference to it.
 *
 * A held job's payload names its questions under `awaitingDecision`; this module is the only reader
 * and writer of that shape. A payload that carries the key in a shape this build cannot read is
 * refused by name, so a release is never left held by a reference nobody can follow.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { agentQuestions, isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import { issueDisplayIds } from '../issues/display-ids.js';
import { logger } from '../logger.js';

export const DECISION_KEY = 'awaitingDecision';
export const AWAITING_DECISION = 'awaiting_decision';

/** What the held-job recovery writes on a release job it fenced while that job waited on a decision
 *  (ISS-1421 r5). The release is handed back and its questions stay open, so the end of its run
 *  voids nothing (`decision-hold.ts:voidOnRunEnd`). */
export const DECISION_HANDBACK_REASON =
  'the release job waited on a decision a person owes, so the release was handed back and its question kept open';

const refSchema = z.object({
  v: z.literal(1),
  sourceJobId: z.uuid(),
  questionIds: z.array(z.uuid()).min(1),
  issueId: z.uuid().nullable(),
  since: z.string(),
  answeredAt: z.string().optional(),
});

export type DecisionRef = z.infer<typeof refSchema>;

/** A held job's payload carries a decision this code cannot read; nothing is guessed from it. */
export class DecisionRefUnreadable extends Error {
  constructor(
    public readonly jobId: string,
    detail: string,
  ) {
    super(
      `DECISION_REF_UNREADABLE: job ${jobId} carries \`${DECISION_KEY}\` in a shape this build does not read (${detail}), so the release it holds cannot be matched to its questions`,
    );
    this.name = 'DecisionRefUnreadable';
  }
}

/** The decision a payload names, `null` where it names none, a named refusal where it is unreadable. */
export function readDecisionRef(jobId: string, payload: unknown): DecisionRef | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as Record<string, unknown>)[DECISION_KEY];
  if (raw === undefined) return null;
  const parsed = refSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DecisionRefUnreadable(jobId, parsed.error.issues[0]?.message ?? 'no reason given');
  }
  return parsed.data;
}

export const JOB_HAS_DECISION = sql`${jobs.payload} -> ${DECISION_KEY} IS NOT NULL`;

export interface HeldDecision {
  heldJobId: string;
  questionIds: string[];
  issueId: string | null;
  /** True when this report had already been taken, and nothing was written for it. */
  replayed: boolean;
}

/** The held successor an earlier report of this blocked job left, if it left one. */
export async function heldDecisionOf(jobId: string, exec: Tx = db): Promise<HeldDecision | null> {
  const rows = await exec
    .select({ id: jobs.id, payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.retryOf, jobId), JOB_HAS_DECISION));
  for (const row of rows) {
    const ref = readDecisionRef(row.id, row.payload);
    if (ref?.sourceJobId === jobId) {
      return {
        heldJobId: row.id,
        questionIds: ref.questionIds,
        issueId: ref.issueId,
        replayed: true,
      };
    }
  }
  return null;
}

/** The decision a held or requeued job of this run waits on, with the job that holds it. */
export async function decisionOfRun(
  runId: string,
): Promise<{ jobId: string; ref: DecisionRef } | null> {
  const [row] = await db
    .select({ id: jobs.id, payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.pipelineRunId, runId), JOB_HAS_DECISION))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (!row) return null;
  const ref = readDecisionRef(row.id, row.payload);
  return ref ? { jobId: row.id, ref } : null;
}

function answerOf(step: QuestionStep | undefined): string | null {
  if (!step) return null;
  if (isChoiceStep(step)) {
    return step.options.find((o) => o.id === step.chosenOptionId)?.label ?? null;
  }
  return step.answerText ?? null;
}

export interface DecisionQuestionView {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  recommendedOptionId: string | null;
  status: string;
  answer: string | null;
}

/** Each question of a decision as it stands, in the order the pane asked them. */
export async function readDecisionQuestions(
  questionIds: readonly string[],
): Promise<DecisionQuestionView[]> {
  const rows = await db
    .select({ id: agentQuestions.id, status: agentQuestions.status, steps: agentQuestions.steps })
    .from(agentQuestions)
    .where(inArray(agentQuestions.id, [...questionIds]));
  return questionIds.flatMap((id) => {
    const row = rows.find((r) => r.id === id);
    const step = row?.steps.at(-1);
    if (!row || !step) return [];
    const choice = isChoiceStep(step);
    return [
      {
        id,
        prompt: step.prompt,
        options: choice ? step.options.map((o) => ({ id: o.id, label: o.label })) : [],
        recommendedOptionId: choice ? step.recommendedOptionId : null,
        status: row.status,
        answer: row.status === 'answered' ? answerOf(step) : null,
      },
    ];
  });
}

export type DecisionPhase = 'waiting' | 'answered' | 'withdrawn';

/** What a release's batch state says about the decision it waits on. */
export interface DecisionReading {
  phase: DecisionPhase;
  since: string;
  /** The issue the questions are open on, `ISS-nn`; `null` where they are at project level. */
  issue: { id: string; displayId: string } | null;
  questions: DecisionQuestionView[];
}

function phaseOf(views: readonly DecisionQuestionView[], expected: number): DecisionPhase {
  if (
    views.length < expected ||
    views.some((v) => v.status !== 'open' && v.status !== 'answered')
  ) {
    return 'withdrawn';
  }
  return views.every((v) => v.status === 'answered') ? 'answered' : 'waiting';
}

export async function readDecisionReading(runId: string): Promise<DecisionReading | null> {
  const decision = await decisionOfRun(runId);
  if (!decision) return null;
  const { ref } = decision;
  const questions = await readDecisionQuestions(ref.questionIds);
  const shown = ref.issueId ? (await issueDisplayIds([ref.issueId])).get(ref.issueId) : undefined;
  return {
    phase: phaseOf(questions, ref.questionIds.length),
    since: ref.since,
    issue: ref.issueId ? { id: ref.issueId, displayId: shown ?? ref.issueId } : null,
    questions,
  };
}

/** What a refusal of a second release says about the first one, when the first one waits on a person. */
export async function inFlightDecision(
  runId: string,
): Promise<{ displayId: string | null } | null> {
  const reading = await readDecisionReading(runId);
  if (reading?.phase !== 'waiting') return null;
  return { displayId: reading.issue?.displayId ?? null };
}

/** The details `BATCH_IN_FLIGHT` carries: the run, and what it waits on where it waits on a person. */
export async function inFlightDetails(runId: string): Promise<Record<string, unknown>> {
  try {
    const waiting = await inFlightDecision(runId);
    return waiting ? { runId, decision: waiting } : { runId };
  } catch (err) {
    logger.warn(
      { err, runId },
      'release-batch: what the release in flight waits on could not be read',
    );
    return { runId };
  }
}
