// What the project's steward may accept on a strict project (REQ-48 r2 decision 2, amended
// 2026-10-21): it holds `suggestions.approve` to reject a breakdown and to route its own triage, so
// its accept is held to the one suggestion that is its own to route, a `feedback_triage` it
// proposed. A breakdown, anyone else's draft or any other kind is a person's or the master's to
// accept there, and the door refuses the steward by name whatever its token names. On every other
// project an agent holding the permission decides (REQ-79 BC-11, BC-12): the fence stands nowhere.

import type { ActorAgency, PermissionRefusal } from '@forge/contracts/permissions';
import { readGateProfile } from '../project-config/index.js';
import { suggestionsPorts } from './ports.js';

export interface AcceptAsked {
  projectId: string;
  actorId: string;
  kind: string;
  producerId: string | null;
}

/** Why the steward may not accept this suggestion, or null where it may (or the actor is not the steward). */
export function stewardAcceptRefusal(
  stewardId: string | null,
  asked: AcceptAsked,
): PermissionRefusal | null {
  if (stewardId === null || asked.actorId !== stewardId) return null;
  if (asked.kind === 'feedback_triage' && asked.producerId === stewardId) return null;
  const whose =
    asked.kind === 'feedback_triage'
      ? 'a feedback triage another proposed'
      : `a ${asked.kind} suggestion`;
  return {
    code: 'PERMISSION_FORBIDDEN',
    path: '',
    detail: `The project's steward accepts only the feedback triage it proposed itself; this is ${whose}, which a person or the master accepts. The steward may reject a breakdown, never accept one (REQ-48 r2 decision 2).`,
    permission: 'suggestions.approve',
    scope: { kind: 'project', id: asked.projectId },
  };
}

/**
 * The accept door's steward fence, on a strict project only: only an agent can be the steward, so a
 * person's accept reads nothing.
 */
export async function acceptFenceRefusal(
  agency: ActorAgency,
  asked: AcceptAsked,
): Promise<PermissionRefusal | null> {
  if (agency !== 'agent') return null;
  if ((await readGateProfile(asked.projectId)) !== 'strict') return null;
  return stewardAcceptRefusal(await suggestionsPorts().stewardOf(asked.projectId), asked);
}
