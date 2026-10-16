import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  mintSecret,
  parseScope,
  pkceAnswers,
  redirectUriFault,
  redirectUriRegistered,
  redirectWith,
} from './mcp-oauth-shape.js';

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

describe('redirectUriFault', () => {
  it('admits https anywhere and http on a loopback host', () => {
    for (const uri of [
      'https://app.example/cb',
      'http://localhost:3000/callback',
      'http://127.0.0.1:43123/callback',
      'http://[::1]:8080/cb',
    ]) {
      expect(redirectUriFault(uri), uri).toBeNull();
    }
  });

  it('names what is wrong with each other shape', () => {
    expect(redirectUriFault('http://app.example/cb')).toContain('loopback');
    expect(redirectUriFault('http://localhost.attacker.example/cb')).toContain('loopback');
    expect(redirectUriFault('myapp://callback')).toContain('neither https');
    expect(redirectUriFault('https://app.example/cb#x')).toContain('fragment');
    expect(redirectUriFault('https://user:pw@app.example/cb')).toContain('credentials');
    expect(redirectUriFault('/callback')).toContain('not an absolute URL');
  });
});

describe('redirectUriRegistered', () => {
  const registered = ['http://127.0.0.1:43123/callback', 'https://app.example/cb'];

  it('matches a loopback URI whatever its port, and nothing else loosely', () => {
    expect(redirectUriRegistered('http://127.0.0.1:50999/callback', registered)).toBe(true);
    expect(redirectUriRegistered('http://127.0.0.1:50999/other', registered)).toBe(false);
    expect(redirectUriRegistered('http://localhost:43123/callback', registered)).toBe(false);
    expect(redirectUriRegistered('https://app.example:8443/cb', registered)).toBe(false);
    expect(redirectUriRegistered('https://app.example/cb', registered)).toBe(true);
  });
});

describe('pkceAnswers', () => {
  const verifier = 'a'.repeat(43);

  it('answers the S256 challenge of its own verifier only', () => {
    expect(pkceAnswers(verifier, challengeOf(verifier))).toBe(true);
    expect(pkceAnswers('b'.repeat(43), challengeOf(verifier))).toBe(false);
  });

  it('refuses a verifier outside 43 to 128 unreserved characters', () => {
    const short = 'a'.repeat(42);
    expect(pkceAnswers(short, challengeOf(short))).toBe(false);
    const long = 'a'.repeat(129);
    expect(pkceAnswers(long, challengeOf(long))).toBe(false);
    expect(pkceAnswers('a'.repeat(128), challengeOf('a'.repeat(128)))).toBe(true);
  });
});

describe('parseScope', () => {
  it('reads both scopes when none is named, and refuses an unknown one by name', () => {
    expect(parseScope(undefined)).toEqual({ scopes: ['read', 'write'] });
    expect(parseScope(' read  read ')).toEqual({ scopes: ['read'] });
    expect(parseScope('read admin')).toEqual({ unknown: 'admin' });
  });
});

describe('mintSecret and redirectWith', () => {
  it('mints prefixed 256-bit secrets and adds parameters to a redirect, keeping its own', () => {
    const { plaintext, hash } = mintSecret('refresh');
    expect(plaintext).toMatch(/^forge_mcp_rt_[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(mintSecret('code').plaintext).toMatch(/^forge_mcp_code_/);
    const to = new URL(
      redirectWith('https://app.example/cb?keep=1', { code: 'c', state: undefined }),
    );
    expect(to.searchParams.get('keep')).toBe('1');
    expect(to.searchParams.get('code')).toBe('c');
    expect(to.searchParams.has('state')).toBe(false);
  });
});
