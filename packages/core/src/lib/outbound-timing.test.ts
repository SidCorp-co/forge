// ISS-1070 r13: live's legs named two calls of ~0.85 s only `http-other`; a call no provider names
// is named by the kind of host it went to, and never by its address.
import { describe, expect, it } from 'vitest';
import { hostKindOf } from './outbound-timing.js';

describe('the kind of host an outbound call went to', () => {
  it('names a known provider by its name', () => {
    expect(hostKindOf('api.github.com')).toBe('github');
    expect(hostKindOf('objects.githubusercontent.com')).toBe('github');
    expect(hostKindOf('gitlab.com')).toBe('gitlab');
    expect(hostKindOf('gitlab.sidcorp.co')).toBe('gitlab');
    expect(hostKindOf('o123.ingest.sentry.io')).toBe('sentry');
    expect(hostKindOf('api.anthropic.com')).toBe('anthropic');
  });

  it('names a loopback host local', () => {
    expect(hostKindOf('127.0.0.1')).toBe('local');
    expect(hostKindOf('localhost')).toBe('local');
    expect(hostKindOf('[::1]')).toBe('local');
  });

  it('tells two other hosts apart without naming either', () => {
    const a = hostKindOf('coolify.internal.example');
    const b = hostKindOf('peer.forge.example');
    expect(a).toMatch(/^other-[0-9a-f]{4}$/);
    expect(b).toMatch(/^other-[0-9a-f]{4}$/);
    expect(a).not.toBe(b);
    expect(hostKindOf('Coolify.Internal.Example')).toBe(a);
    expect(`${a}${b}`).not.toMatch(/example|coolify|peer/);
  });

  it('does not take a host that only contains a provider name for it', () => {
    expect(hostKindOf('github.com.attacker.example')).toMatch(/^other-/);
    expect(hostKindOf('notgithub.com')).toMatch(/^other-/);
  });
});
