// Writing the phase journal (agent-driven pipeline, phase 2).
//
// The table is `db/schema-journal.ts`; this is the only place rows are made.
// Two rules live here rather than in prose: a phase re-entered gets the next
// attempt number instead of colliding, and a verdict is stamped as
// runner-written no matter who asked for it.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
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

export interface VerdictInput {
  decision: 'approve' | 'request_changes' | 'abstain';
  findings?: unknown[];
}

/**
 * Shape the row for a verdict. Split out from the write so the integrity rule
 * is testable without a database: whatever the caller passes, the source is
 * `runner`.
 */
export function buildVerdictEntry(input: EndPhaseInput & { source?: string }): {
  outcome: PhaseJournalOutcome;
  artifact: PhaseArtifact;
  source: 'runner';
} {
  return {
    outcome: input.outcome,
    artifact: input.artifact ?? { kind: 'verdict', decision: 'abstain' },
    // cm:guard forced, never taken from the caller — the DB CHECK is the backstop for a path that bypasses this function, not a substitute for it
    source: 'runner',
  };
}

/**
 * Next attempt number for a phase on a run. A review that sends code back
 * re-enters `code`, and each round must be its own row so the journal shows how
 * many times it went around.
 */
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
      ),
    );
}

/**
 * Record a review result. Separate from {@link endPhase} because the row it
 * writes is the one the driver is not allowed to author.
 */
export async function recordVerdict(
  input: Omit<EndPhaseInput, 'artifact'> & { verdict: VerdictInput },
): Promise<void> {
  const entry = buildVerdictEntry({
    ...input,
    artifact: { kind: 'verdict', ...input.verdict },
  });
  const updated = await db
    .update(phaseJournal)
    .set({
      outcome: entry.outcome,
      artifact: entry.artifact,
      source: entry.source,
      endedAt: new Date(),
    })
    .where(
      and(
        eq(phaseJournal.runId, input.runId),
        eq(phaseJournal.phase, input.phase),
        eq(phaseJournal.attempt, input.attempt),
      ),
    )
    .returning({ id: phaseJournal.id });
  // cm:guard an UPDATE matching no row must throw, not return 200 — a verdict that lands nowhere is indistinguishable from a review that never ran, and the reviewer is the one check the driver cannot perform on itself
  if (updated.length === 0) {
    throw new Error(
      `phase_journal: no row for ${input.phase} attempt ${input.attempt} on run ${input.runId}`,
    );
  }
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
