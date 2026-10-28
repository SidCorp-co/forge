// The issue doors' gates under the project's gate profile (REQ-76): resolved from the project document
// the issues port reads, once per act. A guard under the move's row lock is handed what was read
// before the lock (`transition-guards.ts:readIssueMoveFacts`), so no guard opens a second connection.

import {
  GATE_IDS,
  type GateId,
  projectGate,
  projectGates,
  type ResolvedGate,
} from '@forge/contracts/gate-profiles';
import { readProjectDocument } from './ports.js';

/** Every gate's mode on one project, by id. */
export type IssueGates = Readonly<Record<GateId, ResolvedGate>>;

export async function readIssueGates(projectId: string): Promise<IssueGates> {
  const document = (await readProjectDocument(projectId))?.document;
  const gates = projectGates(document, null);
  return Object.fromEntries(
    GATE_IDS.map((id, at) => [id, gates[at] as ResolvedGate]),
  ) as IssueGates;
}

/** One gate's mode on `projectId`; `known` where the caller already read them. */
export async function issueGateOf(
  projectId: string,
  id: GateId,
  known?: IssueGates | undefined,
): Promise<ResolvedGate> {
  if (known) return known[id];
  return projectGate((await readProjectDocument(projectId))?.document, null, id);
}
