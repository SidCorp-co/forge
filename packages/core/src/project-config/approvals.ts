// The project's person gates (`@forge/contracts/person-gates`), read from its project document and
// nothing else: absent, or a project with no document, every step needs no person.

import type { ProjectPermission } from '@forge/contracts/permissions';
import {
  type Approvals,
  type PersonGate,
  personGateAct,
  personGatePermission,
} from '@forge/contracts/person-gates';
import { readProjectDocument } from './service.js';

export async function readApprovals(projectId: string): Promise<Approvals | null> {
  const doc = await readProjectDocument(projectId);
  return doc?.document.approvals ?? null;
}

/** What the step's move asks of its mover on `projectId`, and the act its refusal names. */
export async function personGateOf(
  projectId: string,
  gate: PersonGate,
): Promise<{ permission: ProjectPermission; act: string }> {
  const approvals = await readApprovals(projectId);
  return {
    permission: personGatePermission(approvals, gate),
    act: personGateAct(approvals, gate),
  };
}
