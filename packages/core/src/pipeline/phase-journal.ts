// Writing the phase journal (agent-driven pipeline, phase 2).
//
// The table is `db/schema-journal.ts`; this is the only place rows are made.
// One rule lives here rather than in prose: a phase re-entered gets the next
// attempt number instead of colliding.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import {
  type NewPhaseJournalRow,
  type PhaseArtifact,
  type PhaseJournalOutcome,
  type PhaseJournalRow,
  phaseJournal,
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

export async function nextAttempt(runId: string, phase: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${phaseJournal.attempt})` })
    .from(phaseJournal)
    .where(and(eq(phaseJournal.runId, runId), eq(phaseJournal.phase, phase)));
  return (row?.max ?? 0) + 1;
}

/** Open a phase. Agent-declared, so `source` is `agent`. */
export async function startPhase(input: StartPhaseInput): Promise<PhaseJournalRow> {
  const attempt = await nextAttempt(input.runId, input.phase);
  const values: NewPhaseJournalRow = {
    projectId: input.projectId,
    runId: input.runId,
    phase: input.phase,
    attempt,
    source: 'agent',
    issueId: input.issueId ?? null,
    jobId: input.jobId ?? null,
    agentSessionId: input.agentSessionId ?? null,
  };
  const [row] = await db.insert(phaseJournal).values(values).returning();
  if (!row) throw new Error(`phase_journal: insert returned no row for ${input.phase}`);
  return row;
}

/** Close a phase the agent opened. */
export async function endPhase(input: EndPhaseInput): Promise<void> {
  await db
    .update(phaseJournal)
    .set({ outcome: input.outcome, artifact: input.artifact, endedAt: new Date() })
    .where(
      and(
        eq(phaseJournal.runId, input.runId),
        eq(phaseJournal.phase, input.phase),
        eq(phaseJournal.attempt, input.attempt),
        sql`(artifact IS NULL OR artifact->>'kind' IS DISTINCT FROM 'verdict')`,
      ),
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
