// Whose account signed in (ISS-1052, REQ-85 BC-1, BC-3). The link core hands the owner is only a
// link: anyone who opens it can sign in at the product. So the binding names the owner's own account
// there (`ownerSignIn.owner`, by `sub` or `email`), core reads who signed in from the id_token or the
// userinfo endpoint the binding declares, and keeps the tokens and records his consent only where
// the two are the same account. A binding naming no owner, or no way to read who signed in, starts
// no sign-in at all.

import type { SupportOwnerAccount, SupportOwnerSignIn } from '@forge/contracts/support';
import {
  type OwnerOauthClient,
  readOwnerUserinfo,
  type SignedInClaims,
} from '../integrations/support-api/index.js';

type ClientConfig = Extract<OwnerOauthClient, { ok: true }>['value'];

/** What a binding declares so core can tell the owner's sign-in from anybody else's. */
export const OWNER_IDENTITY_TO_DECLARE =
  "ownerSignIn.owner { claim: 'sub' | 'email', value }, the owner's own account at the product, and a way to read who signed in: the openid scope in ownerSignIn.scopes, so the product returns an id_token, or ownerSignIn.userinfoUrl";

/**
 * Why core cannot tell whose account signs in through this binding's sign-in, or null where it can:
 * it names no owner account, or neither asks for an id_token nor declares a userinfo endpoint.
 */
export function ownerIdentityFault(product: string, signIn: SupportOwnerSignIn): string | null {
  const reads = signIn.userinfoUrl !== undefined || (signIn.scopes ?? []).includes('openid');
  if (signIn.owner && reads) return null;
  const why = !signIn.owner
    ? `the support-api binding of ${product} names no owner account`
    : `the support-api binding of ${product} gives Forge no way to read who signed in (no openid scope, no userinfoUrl)`;
  return `${why}, so anybody who opened the link could sign in as the owner; no sign-in was started. Declare ${OWNER_IDENTITY_TO_DECLARE}.`;
}

/** Who signed in, as the product says, or why it said nothing Forge can use. */
export async function signedInAs(
  configuration: ClientConfig,
  signIn: SupportOwnerSignIn,
  trade: { accessToken: string; idClaims: SignedInClaims | null },
): Promise<{ ok: true; claims: SignedInClaims } | { ok: false; reason: string }> {
  if (signIn.userinfoUrl) {
    const read = await readOwnerUserinfo(
      configuration,
      trade.accessToken,
      trade.idClaims?.sub ?? null,
    );
    if (read.kind === 'ok') return { ok: true, claims: read.claims };
    return {
      ok: false,
      reason: `its userinfo endpoint did not answer who signed in (${read.reason})`,
    };
  }
  if (trade.idClaims) return { ok: true, claims: trade.idClaims };
  return { ok: false, reason: 'it returned no id_token naming who signed in' };
}

/** The account that signed in, in words a person reads: its email where it has one, and its sub. */
export const accountWords = (claims: SignedInClaims): string =>
  claims.email ? `${claims.email} (sub ${claims.sub})` : `sub ${claims.sub}`;

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether the account that signed in is the owner's, by the claim the binding names: the same `sub`,
 * or the same email (case aside) that the product does not call unverified.
 */
export function isOwnerAccount(owner: SupportOwnerAccount, claims: SignedInClaims): boolean {
  if (owner.claim === 'sub') return claims.sub === owner.value;
  return (
    claims.email !== undefined &&
    claims.emailVerified !== false &&
    sameEmail(claims.email, owner.value)
  );
}
