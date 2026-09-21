import { describe, expect, it } from 'vitest';
import type { RunnerBuildComparison } from '../../devices/build-state.js';
import type { Runner } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';

const runner = (over: Partial<Runner> = {}): Runner =>
  ({
    id: 'r1',
    projectId: 'p1',
    type: 'claude-code',
    deviceId: 'd1',
    name: 'box',
    labels: [],
    capabilities: {},
    config: {},
    status: 'online',
    lastSeenAt: new Date(),
    ...over,
  }) as Runner;

const build = (state: RunnerBuildComparison['state'], detail: string): RunnerBuildComparison => ({
  state,
  detail,
});

describe('claude-code health — liveness, unchanged', () => {
  it('refuses a runner that is not online, naming the status', async () => {
    const r = await claudeCodeAdapter.health({ runner: runner({ status: 'offline' }) });
    expect(r).toEqual({ ok: false, lastError: 'status=offline' });
  });

  it('refuses a runner that has never been seen', async () => {
    const r = await claudeCodeAdapter.health({ runner: runner({ lastSeenAt: null }) });
    expect(r).toEqual({ ok: false, lastError: 'no heartbeat seen' });
  });

  it('refuses a stale heartbeat, naming its age', async () => {
    const r = await claudeCodeAdapter.health({
      runner: runner({ lastSeenAt: new Date(Date.now() - 120_000) }),
    });
    expect(r.ok).toBe(false);
    expect(r.lastError).toMatch(/^stale heartbeat 1\d\ds$/);
  });

  it('refuses a stale heartbeat before it looks at the build', async () => {
    const r = await claudeCodeAdapter.health({
      runner: runner({ lastSeenAt: new Date(Date.now() - 120_000) }),
      build: build('current', 'up to date'),
    });
    expect(r.lastError).toContain('stale heartbeat');
  });
});

describe('claude-code health — the build the box is running', () => {
  it('refuses a live box that is behind, naming what it is behind', async () => {
    const r = await claudeCodeAdapter.health({
      runner: runner(),
      build: build('behind', 'runner 0.17.0 is behind the published 0.17.1'),
    });
    expect(r.ok).toBe(false);
    expect(r.lastError).toBe('runner 0.17.0 is behind the published 0.17.1');
  });

  it('refuses a live box that did not say which build it is running', async () => {
    const r = await claudeCodeAdapter.health({
      runner: runner(),
      build: build('unknown', 'this box did not say which build it is running'),
    });
    expect(r.ok).toBe(false);
    expect(r.lastError).toBe('this box did not say which build it is running');
  });

  it('passes a live box whose build is what the default branch holds', async () => {
    const r = await claudeCodeAdapter.health({
      runner: runner(),
      build: build('current', 'runner 0.17.1 (fbe6468ddf) is what the default branch holds'),
    });
    expect(r.ok).toBe(true);
    expect(r.details).toMatchObject({ build: 'current' });
  });

  it('says the build went unread rather than claiming it passed, where no comparison came', async () => {
    const r = await claudeCodeAdapter.health({ runner: runner() });
    expect(r.ok).toBe(true);
    expect(r.details).toMatchObject({ build: 'unread' });
  });
});
