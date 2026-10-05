// Writing the phase journal (agent-driven pipeline, phase 2).
//
// The table is `db/schema-journal.ts`; agents' rows are made here and
// `phase-journal-backfill.ts` derives `system` rows for runs that predate it.
// One rule lives here rather than in prose: a phase re-entered gets the next
// attempt number instead of colliding.

import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { agentSessions } from '../db/schema-agent-sessions.js';
import {
  type NewPhaseJournalRow,
  type PhaseArtifact,
  type PhaseJournalOutcome,
  type PhaseJournalRow,
  phaseJournal,
} from '../db/schema-journal.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { refusePipeline } from './refuse.js';

interface StartPhaseInput {
  projectId: string;
  runId: string;
  phase: string;
  issueId?: string | null;
  jobId?: string | null;
  agentSessionId?: string | null;
}

interface EndPhaseInput {
  runId: string;
  phase: string;
  attempt: number;
  outcome: PhaseJournalOutcome;
  artifact?: PhaseArtifact;
}

/** A job or session named on a phase belongs to the run the phase is opened on. */
async function assertRefsInRun(input: StartPhaseInput): Promise<void> {
  if (input.jobId) {
    const [job] = await db
      .select({ runId: jobs.pipelineRunId })
      .from(jobs)
      .where(eq(jobs.id, input.jobId))
      .limit(1);
    if (job?.runId !== input.runId) {
      throw refusePipeline(
        'PHASE_REF_NOT_IN_RUN',
        `job ${input.jobId} is not a job of run ${input.runId}`,
        '/jobId',
      );
    }
  }
  if (input.agentSessionId) {
    const [session] = await db
      .select({ runId: agentSessions.pipelineRunId })
      .from(agentSessions)
      .where(eq(agentSessions.id, input.agentSessionId))
      .limit(1);
    if (session?.runId !== input.runId) {
      throw refusePipeline(
        'PHASE_REF_NOT_IN_RUN',
        `agent session ${input.agentSessionId} is not a session of run ${input.runId}`,
        '/agentSessionId',
      );
    }
  }
}

/**
 * Open a phase. Agent-declared, so `source` is `agent`. The attempt is taken in the insert itself
 * under the one-row-per-attempt index, so two concurrent starts cannot both hold one number.
 */
export async function startPhase(input: StartPhaseInput): Promise<PhaseJournalRow> {
  await assertRefsInRun(input);
  const values: Omit<NewPhaseJournalRow, 'attempt'> = {
    projectId: input.projectId,
    runId: input.runId,
    phase: input.phase,
    source: 'agent',
    issueId: input.issueId ?? null,
    jobId: input.jobId ?? null,
    agentSessionId: input.agentSessionId ?? null,
  };
  try {
    const [row] = await db
      .insert(phaseJournal)
      .values({
        ...values,
        attempt: sql`(SELECT COALESCE(max(${phaseJournal.attempt}), 0) + 1 FROM ${phaseJournal} WHERE ${phaseJournal.runId} = ${input.runId} AND ${phaseJournal.phase} = ${input.phase})`,
      })
      .returning();
    if (!row) throw new Error(`phase_journal: insert returned no row for ${input.phase}`);
    return row;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw refusePipeline(
      'PHASE_ATTEMPT_CONFLICT',
      `phase \`${input.phase}\` of run ${input.runId} was opened concurrently by another call; read the run's phases and end or reuse the attempt it holds`,
      '/phase',
    );
  }
}

/** Close a phase the agent opened, or refuse naming the attempt that is not open. */
export async function endPhase(input: EndPhaseInput): Promise<void> {
  const closed = await db
    .update(phaseJournal)
    .set({ outcome: input.outcome, artifact: input.artifact, endedAt: new Date() })
    .where(
      and(
        eq(phaseJournal.runId, input.runId),
        eq(phaseJournal.phase, input.phase),
        eq(phaseJournal.attempt, input.attempt),
        isNull(phaseJournal.endedAt),
      ),
    )
    .returning({ id: phaseJournal.id });
  if (closed.length > 0) return;
  const [held] = await db
    .select({ outcome: phaseJournal.outcome })
    .from(phaseJournal)
    .where(
      and(
        eq(phaseJournal.runId, input.runId),
        eq(phaseJournal.phase, input.phase),
        eq(phaseJournal.attempt, input.attempt),
      ),
    )
    .limit(1);
  if (held?.outcome === input.outcome) return;
  throw refusePipeline(
    'PHASE_NOT_OPEN',
    held
      ? `attempt ${input.attempt} of phase \`${input.phase}\` on run ${input.runId} already ended \`${held.outcome}\`; a closed attempt is not ended again with another outcome`
      : `run ${input.runId} holds no attempt ${input.attempt} of phase \`${input.phase}\`; read GET /pipeline-runs/${input.runId}/phases for the attempts it holds`,
    '/attempt',
  );
}

/**
 * Close every phase this job left open, once the job itself is terminal.
 * Returns how many rows were closed.
 */
export async function closeDanglingPhasesForJob(
  jobId: string,
  outcome: PhaseJournalOutcome,
): Promise<number> {
  const [job] = await db
    .select({ runId: jobs.pipelineRunId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  const owned = eq(phaseJournal.jobId, jobId);
  const unowned = job?.runId
    ? and(eq(phaseJournal.runId, job.runId), isNull(phaseJournal.jobId))
    : undefined;
  const closed = await db
    .update(phaseJournal)
    .set({ outcome, source: 'system', endedAt: new Date() })
    .where(and(unowned ? or(owned, unowned) : owned, isNull(phaseJournal.endedAt)))
    .returning({ id: phaseJournal.id });
  return closed.length;
}

export async function listPhases(runId: string): Promise<PhaseJournalRow[]> {
  return db
    .select()
    .from(phaseJournal)
    .where(eq(phaseJournal.runId, runId))
    .orderBy(asc(phaseJournal.startedAt), asc(phaseJournal.attempt));
}

/**
 * The phase a dead session stopped in — the newest row with no `ended_at`.
 * A resuming session restarts here rather than at phase 1.
 */
export async function resumePoint(runId: string): Promise<PhaseJournalRow | null> {
  const [row] = await db
    .select()
    .from(phaseJournal)
    .where(and(eq(phaseJournal.runId, runId), isNull(phaseJournal.endedAt)))
    .orderBy(desc(phaseJournal.startedAt))
    .limit(1);
  return row ?? null;
}
