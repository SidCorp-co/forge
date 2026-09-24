import { describe, expect, it } from 'vitest';
import { heartbeatPatch } from './heartbeat-patch.js';

const NOW = new Date('2026-09-21T12:00:00Z');

describe('heartbeatPatch', () => {
  it('always marks the box seen and online', () => {
    expect(heartbeatPatch({}, NOW)).toEqual({ lastSeenAt: NOW, status: 'online' });
  });

  it('writes the version and the commit the box reported', () => {
    expect(heartbeatPatch({ agentVersion: '0.17.1', agentCommit: 'fbe6468ddf' }, NOW)).toEqual({
      lastSeenAt: NOW,
      status: 'online',
      agentVersion: '0.17.1',
      agentCommit: 'fbe6468ddf',
    });
  });

  // The identity moves as one. A box that came back on an unstamped build reports
  // a version and no commit; keeping the commit its last release reported would let
  // that build pass for the release it was made from.
  it('clears the stored commit where a version-bearing heartbeat sends none', () => {
    expect(heartbeatPatch({ agentVersion: '0.17.1' }, NOW)).toEqual({
      lastSeenAt: NOW,
      status: 'online',
      agentVersion: '0.17.1',
      agentCommit: null,
    });
  });

  it('changes neither where the heartbeat reports no version at all', () => {
    const patch = heartbeatPatch({ capabilities: { skills: [] } }, NOW);
    expect(patch).not.toHaveProperty('agentVersion');
    expect(patch).not.toHaveProperty('agentCommit');
  });

  it('writes an empty commit the box did send, rather than treating it as silence', () => {
    expect(heartbeatPatch({ agentVersion: '0.17.1', agentCommit: '' }, NOW)).toHaveProperty(
      'agentCommit',
      '',
    );
  });

  it('carries capabilities through untouched', () => {
    const capabilities = { skills: ['a'] };
    expect(heartbeatPatch({ capabilities }, NOW).capabilities).toBe(capabilities);
  });

  // A box that goes quiet about its gate has not told us the gate recovered.
  it('leaves the stored gate alone where the heartbeat carried none', () => {
    const patch = heartbeatPatch({ agentVersion: '0.17.1' }, NOW);
    expect(patch).not.toHaveProperty('gateReport');
  });

  it('stores what the box sent together with the time core heard it', () => {
    const degraded = {
      verdict: 'failing_open' as const,
      count: 279,
      trimmed: true,
      firstAt: 1,
      lastAt: 2,
      windowMs: 1,
      perDay: 73.8,
      sinceLastMs: 3,
      last: null,
      byReason: [{ reason: 'no control capability', count: 279 }],
    };
    expect(heartbeatPatch({ gate: { degraded } }, NOW).gateReport).toEqual({
      degraded,
      receivedAt: NOW.toISOString(),
    });
  });
});
