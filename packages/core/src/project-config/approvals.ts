// The project's person gates (`@forge/contracts/person-gates`), read from its project document as its
// gate profile resolves them (REQ-76): absent, or a project with no document, every step needs no person.

import type { ProjectPermission } from '@forge/contracts/permissions';
import {
  effectiveApprovals,
  type PersonGate,
  personGateAct,
  personGatePermission,
} from '@forge/contracts/person-gates';
import { readProjectDocument } from './service.js';

/** Each step's switch as the project's gate profile resolves it (`effectiveApprovals`). */
export async function readApprovals(
  projectId: string,
): Promise<Readonly<Record<PersonGate, boolean>>> {
  return effectiveApprovals((await readProjectDocument(projectId))?.document);
}

/** What the step's move asks of its mover on `projectId`, and the act its refusal names (`label` where another act shares the switch). */
export async function personGateOf(
  projectId: string,
  gate: PersonGate,
  label?: string,
): Promise<{ permission: ProjectPermission; act: string }> {
  const document = (await readProjectDocument(projectId))?.document;
  return {
    permission: personGatePermission(effectiveApprovals(document), gate),
    act: personGateAct(document, gate, label),
  };
}
