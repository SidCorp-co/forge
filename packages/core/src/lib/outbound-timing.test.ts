// ISS-1070 r13: live's legs named two calls of ~0.85 s only `http-other`; a call no provider names
// is named by the kind of host it went to, and never by its address.
import { describe, expect, it } from 'vitest';
import { hostKindOf } from './outbound-timing.js';

describe('the kind of host an outbound call went to', () => {
  it('names a loopback host local', () => {
    expect(hostKindOf('127.0.0.1')).toBe('local');
    expect(hostKindOf('localhost')).toBe('local');
    expect(hostKindOf('[::1]')).toBe('local');
  });

  it('tells two other hosts apart without naming either, whatever their case', () => {
    const a = hostKindOf('coolify.internal.example');
    const b = hostKindOf('peer.forge.example');
    expect(a).toMatch(/^host-[0-9a-f]{4}$/);
    expect(b).toMatch(/^host-[0-9a-f]{4}$/);
    expect(a).not.toBe(b);
    expect(hostKindOf('Coolify.Internal.Example')).toBe(a);
    expect(`${a}${b}`).not.toMatch(/example|coolify|peer/);
  });
});
