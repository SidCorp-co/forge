import type { PatPrincipal } from '../middleware/require-pat.js';
import type { VerifiedPat } from './pat.js';

/**
 * The one place a token row becomes a principal, so a token core mints for itself acts
 * exactly as it would when presented at a door.
 */
export function patPrincipalOf({ row, ownerKind }: VerifiedPat): PatPrincipal {
  return {
    kind: 'pat',
    agency: ownerKind,
    agentUserId: ownerKind === 'agent' ? row.userId : null,
    userId: row.userId,
    tokenId: row.id,
    scopes: row.scopes,
    projectIds: row.projectIds ?? null,
    permissions: row.permissions ?? null,
    grantEpoch: row.grantEpoch,
    boundProjectId: row.boundProjectId ?? null,
    deviceId: row.deviceId ?? null,
  };
}
