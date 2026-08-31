// `forge_phase` — how an autonomous session declares where it is.
//
// The staged pipeline knew a step had started because it dispatched a job for
// it. One session running all seven phases has no such boundary, so the
// session says so itself, and the journal row it writes IS the resume point:
// a session that dies restarts at the last phase declared, not at phase 1.
//
// Verdicts are deliberately absent from this tool. A review verdict may only
// be written by the runner (`db/schema-journal.ts` enforces it as a CHECK),
// and a tool the agent can call is by definition agent-written.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { z } from 'zod';
import { phaseJournalOutcomes } from '../../db/schema-journal.js';
import { endPhase, resumePoint, startPhase } from '../../pipeline/phase-journal.js';
import { findRunProjectId } from '../../pipeline/runs.js';
import type { ContextScopedMcpToolFactory } from './lib.js';
import { assertPrincipalIsWriter, zodToMcpSchema } from './lib.js';

const inputSchema = z.object({
  action: z.enum(['start', 'end', 'resume_point']),
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  phase: z.string().min(1).max(64).optional(),
  attempt: z.number().int().positive().optional(),
  outcome: z.enum(phaseJournalOutcomes).optional(),
  issueId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  agentSessionId: z.string().uuid().optional(),
  note: z.string().max(4000).optional(),
});

// cm:guard the run must belong to the project the principal was authorised against — assertPrincipalIsWriter checks the PROJECT, so without this a writer on any project could append phases to any run in the fleet
async function assertRunInProject(runId: string, projectId: string): Promise<void> {
  const owner = await findRunProjectId(runId);
  if (!owner) throw new Error('NOT_FOUND: pipeline run not found');
  if (owner !== projectId) throw new Error('NOT_FOUND: pipeline run not found in project');
}

export const forgePhaseTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_phase',
  description:
    "Declare which phase of an autonomous run you are in. Call action `start` BEFORE beginning a phase (understand, plan, code, self-review, review, merge, ship) and action `end` when it finishes, with `outcome` one of ok/failed/abandoned. The `start` call returns the `attempt` number to pass back to `end`; re-entering a phase (a review sending you back to code) starts a new attempt rather than overwriting the old one, so the journal shows the rounds. Action `resume_point` returns the newest phase with no end recorded — a session resuming after a death restarts there instead of at phase 1. You CANNOT write a review verdict here: a verdict is recorded by the runner from the reviewer's structured result, and the database refuses an agent-authored one.",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertPrincipalIsWriter(ctx.principal, input.projectId);
    await assertRunInProject(input.runId, input.projectId);

    if (input.action === 'resume_point') {
      const row = await resumePoint(input.runId);
      return row
        ? { resumePoint: { phase: row.phase, attempt: row.attempt, startedAt: row.startedAt } }
        : { resumePoint: null };
    }

    if (!input.phase) throw new Error('BAD_REQUEST: phase is required for start and end');

    if (input.action === 'start') {
      const row = await startPhase({
        projectId: input.projectId,
        runId: input.runId,
        phase: input.phase,
        issueId: input.issueId ?? null,
        jobId: input.jobId ?? null,
        agentSessionId: input.agentSessionId ?? null,
      });
      return { phase: row.phase, attempt: row.attempt, startedAt: row.startedAt };
    }

    if (input.attempt === undefined) {
      throw new Error('BAD_REQUEST: attempt is required for end — pass the one start returned');
    }
    if (!input.outcome) throw new Error('BAD_REQUEST: outcome is required for end');
    await endPhase({
      runId: input.runId,
      phase: input.phase,
      attempt: input.attempt,
      outcome: input.outcome,
      ...(input.note ? { artifact: { kind: 'note', text: input.note } } : {}),
    });
    return { phase: input.phase, attempt: input.attempt, outcome: input.outcome };
  },
});
