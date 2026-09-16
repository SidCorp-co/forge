// ISS-886 — the one status the autonomous driver cannot be left on.
//
// `waiting` means "a human owes this issue something", and on this mode that is
// what `needs_info` IS: `answer-resume.ts` restarts `needs_info` and nothing
// else, so an agent's `waiting` is a park no comment could ever wake. It took 27
// of them before the rewrite existed.
//
// So the status is rewritten at write time rather than detected afterwards —
// the shape of `issues/intake-gate.ts`, for the same reason: a park no
// dispatcher will ever pick up must not be representable.
//
// `reopen` was rewritten here too until 2026-09-10 and is NOT any more. That
// rewrite rested on a claim about meaning — the staged pipeline read `reopen` as
// "a step rejected this, route it back to the step that owns the fix", and this
// mode has no steps — and the nine-status vocabulary changed exactly that: it
// means a person disagreed with a close, which is not a step and is nobody's to
// route but theirs. The ISS-141 wedge it was written from (an hour at `reopen`
// rendering as live while the reconciler counted a rescue every 60s) cannot
// return through this door: `reconciler.ts` selects AUTONOMOUS_INFLIGHT_STATUSES,
// which is `['in_progress']` and never reads it.

import type { IssueStatus } from '../db/schema.js';
import { AUTONOMOUS_QUESTION_STATUS } from '../pipeline/autonomous-mode.js';
import { isAutonomousProject } from '../pipeline/autonomous-project.js';
import type { ActorAgency } from './actor-agency.js';

export interface AutonomousParkInput {
  projectId: string;
  requested: IssueStatus;
  agency: ActorAgency;
}

/**
 * Rewrite a park the autonomous driver cannot be restarted from into the one it
 * can. Every other target, and every staged project, passes through untouched —
 * one project's driver must never change another's vocabulary.
 */
export async function resolveAutonomousParkTarget(
  input: AutonomousParkInput,
): Promise<IssueStatus> {
  if (!isRewritablePark(input)) return input.requested;
  if (!(await isAutonomousProject(input.projectId))) return input.requested;
  return AUTONOMOUS_QUESTION_STATUS;
}

function isRewritablePark(input: AutonomousParkInput): boolean {
  if (input.requested !== 'waiting') return false;
  return input.agency === 'agent';
}
