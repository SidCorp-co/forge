import type { ActorAgency } from '@forge/contracts/permissions';
import type { UserKind } from '../db/schema.js';
import type { PatPrincipal } from '../middleware/require-pat.js';
import type { VerifiedPat } from './pat.js';
import { statedPatGrant } from './pat-permissions.js';

/**
 * The one place a token row becomes a principal, so a token core mints for itself acts
 * exactly as it would when presented at a door. A row stating no grant is refused here.
 */
export function patPrincipalOf({ row, ownerKind }: VerifiedPat): PatPrincipal {
  return {
    kind: 'pat',
    agency: credentialAgency({ ownerKind, deviceId: row.deviceId ?? null }),
    agentUserId: ownerKind === 'agent' ? row.userId : null,
    userId: row.userId,
    tokenId: row.id,
    scopes: row.scopes,
    projectIds: row.projectIds ?? null,
    permissions: statedPatGrant(row.permissions, row.tokenPrefix),
    grantEpoch: row.grantEpoch,
    boundProjectId: row.boundProjectId ?? null,
    deviceId: row.deviceId ?? null,
    onBehalfOf: row.onBehalfOf ?? null,
  };
}

// a token bound to a paired box is the box's, an agent's, whoever holds it (the holder stays `userId`); an unbound token carries its holder's `users.kind`
export function credentialAgency(input: {
  ownerKind: UserKind;
  deviceId: string | null;
}): ActorAgency {
  if (input.deviceId !== null) return 'agent';
  return input.ownerKind;
}
