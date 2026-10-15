// Writing the phase half of the run journal (agent-driven pipeline, phase 2).
//
// The table is `db/schema-journal.ts:runJournal`; this and `issue-context-store.ts` are the only
// places its rows are made. A phase re-entered gets the next attempt number instead of colliding,
// and an attempt is ended once: a second end is refused by name, never written over the first.

import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import {
  type NewRunJournalRow,
  type PhaseArtifact,
  type PhaseJournalOutcome,
  type RunJournalRow,
  runJournal,
} from '../db/schema-journal.js';

export interface StartPhaseInput {
  projectId: string;
  runId: string;
  phase: string;
  issueId?: string | null;
  jobId?: string | null;
  agentSessionId?: string | null;
}

export interface EndPhaseInput {
  runId: string;
  phase: string;
  attempt: number;
  outcome: PhaseJournalOutcome;
  artifact?: PhaseArtifact;
}

/** Why an end was not written: the attempt is not in the journal, it already ended, or it holds a
 *  verdict the runner wrote. Each leaves the row as it was. */
export class PhaseEndRefused extends Error {
  constructor(
    readonly code: 'PHASE_NOT_FOUND' | 'PHASE_ALREADY_ENDED' | 'PHASE_HOLDS_VERDICT',
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = 'PhaseEndRefused';
  }
}

export async function nextAttempt(runId: string, phase: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${runJournal.attempt})` })
    .from(runJournal)
    .where(and(eq(runJournal.runId, runId), eq(runJournal.phase, phase)));
  return (row?.max ?? 0) + 1;
}

/** Open a phase. Agent-declared, so `source` is `agent`. */
export async function startPhase(input: StartPhaseInput): Promise<RunJournalRow> {
  const attempt = await nextAttempt(input.runId, input.phase);
  const values: NewRunJournalRow = {
    projectId: input.projectId,
    runId: input.runId,
    phase: input.phase,
    attempt,
    source: 'agent',
    issueId: input.issueId ?? null,
    jobId: input.jobId ?? null,
    agentSessionId: input.agentSessionId ?? null,
  };
  const [row] = await db.insert(runJournal).values(values).returning();
  if (!row) throw new Error(`run_journal: insert returned no row for ${input.phase}`);
  return row;
}

/** Close a phase the agent opened, once. */
export async function endPhase(input: EndPhaseInput): Promise<RunJournalRow> {
  const attemptOf = and(
    eq(runJournal.runId, input.runId),
    eq(runJournal.phase, input.phase),
    eq(runJournal.attempt, input.attempt),
  );
  const [ended] = await db
    .update(runJournal)
    .set({ outcome: input.outcome, artifact: input.artifact, endedAt: new Date() })
    .where(
      and(
        attemptOf,
        isNull(runJournal.endedAt),
        sql`(artifact IS NULL OR artifact->>'kind' IS DISTINCT FROM 'verdict')`,
      ),
    )
    .returning();
  if (ended) return ended;
  const [held] = await db.select().from(runJournal).where(attemptOf).limit(1);
  const named = `phase \`${input.phase}\` attempt ${input.attempt} of run ${input.runId}`;
  if (!held) {
    throw new PhaseEndRefused(
      'PHASE_NOT_FOUND',
      `${named} was never started, so there is nothing to end — start it, and end the attempt that start returns`,
      404,
    );
  }
  if (held.endedAt) {
    throw new PhaseEndRefused(
      'PHASE_ALREADY_ENDED',
      `${named} already ended \`${held.outcome}\` at ${held.endedAt.toISOString()}; the journal keeps the first end and this one was not written. Re-entering the phase is a new attempt: start it again`,
      409,
    );
  }
  throw new PhaseEndRefused(
    'PHASE_HOLDS_VERDICT',
    `${named} holds a verdict the runner wrote, which an agent's end does not replace; nothing was written`,
    409,
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
  const owned = eq(runJournal.jobId, jobId);
  const unowned = job?.runId
    ? and(eq(runJournal.runId, job.runId), isNull(runJournal.jobId))
    : undefined;
  const closed = await db
    .update(runJournal)
    .set({ outcome, endedAt: new Date() })
    .where(and(unowned ? or(owned, unowned) : owned, isNull(runJournal.endedAt)))
    .returning({ id: runJournal.id });
  return closed.length;
}

export async function listPhases(runId: string): Promise<RunJournalRow[]> {
  return db
    .select()
    .from(runJournal)
    .where(eq(runJournal.runId, runId))
    .orderBy(asc(runJournal.startedAt), asc(runJournal.attempt));
}

/**
 * The phase a dead session stopped in — the newest row with no `ended_at`.
 * A resuming session restarts here rather than at phase 1.
 */
export async function resumePoint(runId: string): Promise<RunJournalRow | null> {
  const [row] = await db
    .select()
    .from(runJournal)
    .where(and(eq(runJournal.runId, runId), isNull(runJournal.endedAt)))
    .orderBy(desc(runJournal.startedAt))
    .limit(1);
  return row ?? null;
}
