import type { IssueStatus, WaitingKind } from '../db/schema.js';
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

/** The kind a park stores: a `waiting` park rewritten to the question status keeps its own (ISS-1310). */
export function storedWaitingKind(
  requested: IssueStatus,
  landed: IssueStatus,
  kind: WaitingKind | undefined,
): WaitingKind | null {
  if (landed === 'waiting') return kind ?? null;
  if (requested === 'waiting' && landed === AUTONOMOUS_QUESTION_STATUS) return kind ?? null;
  return null;
}
