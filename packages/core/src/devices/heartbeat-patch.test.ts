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

  it('leaves the stored commit alone where the box sent none', () => {
    expect(heartbeatPatch({ agentVersion: '0.17.1' }, NOW)).not.toHaveProperty('agentCommit');
  });

  it('leaves the stored version alone where the box sent none', () => {
    expect(heartbeatPatch({ agentCommit: 'fbe6468ddf' }, NOW)).not.toHaveProperty('agentVersion');
  });

  it('writes an empty commit the box did send, rather than treating it as silence', () => {
    expect(heartbeatPatch({ agentCommit: '' }, NOW)).toHaveProperty('agentCommit', '');
  });

  it('carries capabilities through untouched', () => {
    const capabilities = { skills: ['a'] };
    expect(heartbeatPatch({ capabilities }, NOW).capabilities).toBe(capabilities);
  });
});
