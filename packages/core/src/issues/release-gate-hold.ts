import type { IssueStatus } from '../db/schema.js';
import { resolveReleaseGate } from '../release-batch/gate.js';
import type { ActorAgency } from './actor-agency.js';

export interface CloseTargetDecision {
  status: IssueStatus;
  /** The close was converted into a park at the gate. */
  held: boolean;
}

export async function resolveAgentCloseTarget(args: {
  projectId: string;
  requested: IssueStatus;
  agency: ActorAgency;
  viaReleasePath: boolean;
}): Promise<CloseTargetDecision> {
  const pass = { status: args.requested, held: false };
  if (args.requested !== 'closed') return pass;
  if (args.agency !== 'agent') return pass;
  if (args.viaReleasePath) return pass;

  const gate = await resolveReleaseGate(args.projectId);
  if (!gate) return pass;
  return { status: gate, held: true };
}
