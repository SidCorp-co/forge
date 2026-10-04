import type { ActorAgency } from '@forge/contracts/permissions';
import { delegationOf } from '../credentials/pat-scope.js';

/**
 * Who acts: the account whose permissions decide, whether a person or an agent is at the keyboard,
 * the credential the act arrived on, and the person that credential acts for (delegation, never
 * impersonation: RFC 8693). Every check takes one, and every kernel move records its token and
 * delegation (`kernel_transitions.actor_token_id`, `actor_on_behalf_of`).
 */
export interface Actor {
  userId: string | null;
  agency: ActorAgency | null;
  tokenId: string | null;
  onBehalfOf: string | null;
}

/**
 * The actor for `userId` in this request. Its token and delegation are the request's own when the
 * request's credential is `userId`'s, and null for a session or for anyone else.
 */
export function actorFor(userId: string | null | undefined, agency?: ActorAgency | null): Actor {
  const delegation = delegationOf(userId);
  return {
    userId: userId ?? null,
    agency: agency ?? delegation.agency,
    tokenId: delegation.tokenId,
    onBehalfOf: delegation.onBehalfOf,
  };
}
