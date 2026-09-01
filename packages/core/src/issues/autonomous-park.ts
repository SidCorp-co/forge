// ISS-141, ISS-886 — the two statuses the autonomous driver cannot be left on.
//
// The staged pipeline reads `reopen` as "a step rejected this; route it back to
// whichever step owns the fix", and `waiting` as "a human owes this issue
// something". The autonomous driver has no steps: `autonomousStepFor` answers
// for `open` and nothing else, and `answer-resume.ts` restarts `needs_info` and
// nothing else. So an issue an agent lands on either status is queued for a
// driver that will never look at it.
//
// Both were measured, not predicted. `reopen` rendered as a live session while
// the reconciler re-read it every 60s and counted a rescue each time —
// epodsystem ISS-141 sat there over an hour on 2026-08-24. `waiting` took 27
// parks no comment could ever wake.
//
// So the status is rewritten at write time rather than detected afterwards —
// the shape of `issues/intake-gate.ts`, for the same reason: a park no
// dispatcher will ever pick up must not be representable.

import type { IssueStatus } from '../db/schema.js';
import {
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_QUESTION_STATUS,
} from '../pipeline/autonomous-mode.js';
import { isAutonomousProject } from '../pipeline/autonomous-project.js';
import type { ActorAgency } from './actor-agency.js';

export interface AutonomousParkInput {
  projectId: string;
  requested: IssueStatus;
  agency: ActorAgency;
  /** This `waiting` is core's decompose review gate, not an agent asking. */
  viaDecomposeGate: boolean;
}

/**
 * Rewrite a park the autonomous driver cannot be restarted from into the one it
 * can. Every other target, and every staged project, passes through untouched —
 * one project's driver must never change another's vocabulary.
 */
// cm:guard call this AFTER the transition guards, never before: `requiresAuthoredReason` and `isReopenEntry` key on the REQUESTED status, and resolving first silently drops the reason requirement, the `waitingKind` requirement and the reopen counter — the entire quality signal these parks carry. What each status MEANS survives precisely because the rewrite lands late: the counter still increments and the authored reason is still posted under its own heading.
export async function resolveAutonomousParkTarget(
  input: AutonomousParkInput,
): Promise<IssueStatus> {
  if (!isRewritablePark(input)) return input.requested;
  if (!(await isAutonomousProject(input.projectId))) return input.requested;
  return input.requested === 'reopen' ? AUTONOMOUS_ENTRY_STATUS : AUTONOMOUS_QUESTION_STATUS;
}

// cm:guard `waiting` is rewritten for a DEVICE actor only while `reopen` is rewritten for every actor, and the asymmetry is the point: a person parking work has chosen to stop it and owns their own resume, so waking them by comment would take that pause away, whereas an agent writing `waiting` is asking a human for something, which on this mode is what `needs_info` IS. `reopen` has no such reading — it names a step, and this mode has none.
// cm:guard `on_hold` is deliberately absent. Its only device-actor writer is the ISS-411 operator cancel, which a human initiated, so rewriting it to a comment-wakeable status would undo the authoritative cancel — and it has been manual-resume in staged mode too, so it is not a hazard this mode introduced.
function isRewritablePark(input: AutonomousParkInput): boolean {
  if (input.requested === 'reopen') return true;
  if (input.requested !== 'waiting') return false;
  return input.agency === 'agent' && !input.viaDecomposeGate;
}
