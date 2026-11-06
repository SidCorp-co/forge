import type { SupportOwnerSignIn } from '@forge/contracts/support';
import { describe, expect, it } from 'vitest';
import { isOwnerAccount, ownerIdentityFault } from './owner-identity.js';

// ISS-1052: only the owner's own account at the product signs in for him, by the claim his binding
// names; a binding naming no owner, or no way to read who signed in, starts no sign-in.

const signIn = (more: Partial<SupportOwnerSignIn>): SupportOwnerSignIn => ({
  authorizationUrl: 'https://agf.example/oauth/authorize',
  tokenUrl: 'https://agf.example/oauth/token',
  clientId: 'forge',
  ...more,
});
const claims = (sub: string, email?: string, emailVerified?: boolean) => ({
  sub,
  email,
  emailVerified,
});

describe('isOwnerAccount', () => {
  it('takes the same sub, and refuses any other sub whatever its email', () => {
    const owner = { claim: 'sub' as const, value: 'u-1' };
    expect(isOwnerAccount(owner, claims('u-1'))).toBe(true);
    expect(isOwnerAccount(owner, claims('u-2', 'u-1'))).toBe(false);
    expect(isOwnerAccount(owner, claims('U-1'))).toBe(false);
  });

  it('takes the same email in any case, and refuses one the product calls unverified', () => {
    const owner = { claim: 'email' as const, value: 'alice@agf.test' };
    expect(isOwnerAccount(owner, claims('x', ' Alice@AGF.test'))).toBe(true);
    expect(isOwnerAccount(owner, claims('x', 'alice@agf.test', true))).toBe(true);
    expect(isOwnerAccount(owner, claims('x', 'alice@agf.test', false))).toBe(false);
    expect(isOwnerAccount(owner, claims('x', 'mallory@agf.test'))).toBe(false);
    // an account the product names by sub alone is never the owner named by email
    expect(isOwnerAccount(owner, claims('alice@agf.test'))).toBe(false);
  });
});

describe('ownerIdentityFault', () => {
  const owner = { claim: 'sub' as const, value: 'u-1' };

  it('passes a binding naming the owner and reading him from an id_token or userinfo', () => {
    expect(ownerIdentityFault('agf', signIn({ owner, scopes: ['openid'] }))).toBeNull();
    expect(
      ownerIdentityFault('agf', signIn({ owner, userinfoUrl: 'https://agf.example/me' })),
    ).toBeNull();
  });

  it('refuses a binding naming no owner, saying what to declare', () => {
    const why = ownerIdentityFault('agf', signIn({ scopes: ['openid'] }));
    expect(why).toContain('names no owner account');
    expect(why).toContain("ownerSignIn.owner { claim: 'sub' | 'email', value }");
  });

  it('refuses a binding naming the owner with no way to read who signed in', () => {
    const why = ownerIdentityFault('agf', signIn({ owner, scopes: ['profile'] }));
    expect(why).toContain('no way to read who signed in');
    expect(why).toContain('ownerSignIn.userinfoUrl');
  });
});
