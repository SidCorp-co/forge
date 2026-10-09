// What accepting a suggestion asks of its accepter: a breakdown waits on a person only where the
// project's `approvals.breakdown` asks one (Requirement lifecycle r15 breakdown_check, REQ-34 r2
// BC-25); every other kind is accepted by a holder of suggestions.approve.

import type { ProjectPermission } from '@forge/contracts/permissions';
import { personGateOf } from '../project-config/index.js';

export async function acceptGateOf(
  projectId: string,
  kind: string,
): Promise<{ permission: ProjectPermission; act: string }> {
  return kind === 'breakdown'
    ? personGateOf(projectId, 'breakdown')
    : { permission: 'suggestions.approve', act: 'accepting a suggestion' };
}
