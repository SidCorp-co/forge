import { PREVIEW_LIMITS } from '@forge/contracts/preview';
import { describe, expect, it } from 'vitest';
import { previewPlan, type SweepFacts, stateRefusal, sweepMove } from './rules.js';

const external = { mode: 'external' as const };

describe('previewPlan: which setting and environment a preview starts with (BC-11, BC-13)', () => {
  it('reads the repository when the project names no setting, and talks to its one dev environment', () => {
    const planned = previewPlan({
      environments: {
        dev: { tier: 'dev', deployment: external, url: 'https://dev.example.test' },
        live: { tier: 'production', deployment: external },
      },
    });
    expect(planned).toEqual({
      ok: true,
      plan: {
        settings: null,
        env: {
          FORGE_PREVIEW: '1',
          FORGE_ENVIRONMENT: 'dev',
          FORGE_ENVIRONMENT_URL: 'https://dev.example.test',
        },
      },
    });
  });

  it('never talks to production: a setting naming a production environment is refused by name', () => {
    const planned = previewPlan({
      preview: { command: 'pnpm dev', port: 3000, environment: 'live' },
      environments: { live: { tier: 'production', deployment: external } },
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.refusal.code).toBe('PREVIEW_PRODUCTION_ENVIRONMENT');
      expect(planned.refusal.path).toBe('/preview/environment');
    }
  });

  it('refuses an environment the project does not declare, naming the ones it does', () => {
    const planned = previewPlan({
      preview: { command: 'pnpm dev', port: 3000, environment: 'qa' },
      environments: { dev: { tier: 'dev', deployment: external } },
    });
    expect(planned.ok ? null : planned.refusal).toMatchObject({
      code: 'PREVIEW_SETTINGS_INVALID',
      detail: expect.stringContaining('dev'),
    });
  });

  it('picks no environment when the project has two dev ones and names neither', () => {
    const planned = previewPlan({
      environments: {
        a: { tier: 'dev', deployment: external },
        b: { tier: 'dev', deployment: external },
      },
    });
    expect(planned).toEqual({ ok: true, plan: { settings: null, env: { FORGE_PREVIEW: '1' } } });
  });
});

describe('stateRefusal', () => {
  it('lets an allowed state through and names a closed or not-yet state', () => {
    expect(stateRefusal('p', 'live', ['live'], 'be approved')).toBeNull();
    expect(stateRefusal('p', 'approved', ['live'], 'be viewed')?.code).toBe('PREVIEW_CLOSED');
    expect(stateRefusal('p', 'starting', ['live', 'idle_closed'], 'be approved')).toMatchObject({
      code: 'PREVIEW_NOT_LIVE',
      detail: expect.stringContaining('live or idle_closed'),
    });
  });
});

const NOW = 1_000_000_000;
const base: SweepFacts = {
  state: 'live',
  idleMinutes: 30,
  liveAt: NOW - 60_000,
  lastViewedAt: NOW - 60_000,
  startedAt: NOW - 120_000,
  tunnel: { up: true, upAt: NOW - 120_000, lostAt: null },
  boxConnected: true,
  watchingSince: NOW - 3_600_000,
};
const grace = PREVIEW_LIMITS.tunnelGraceSeconds * 1000;

describe('sweepMove: what the sweep owes a preview (BC-9, BC-10)', () => {
  it('idles a live preview nobody viewed for its setting, and not a minute before', () => {
    expect(sweepMove({ ...base, lastViewedAt: NOW - 29 * 60_000 }, NOW)).toBeNull();
    expect(sweepMove({ ...base, lastViewedAt: NOW - 31 * 60_000 }, NOW)).toMatchObject({
      to: 'idle_closed',
    });
  });

  it('fails a live preview whose tunnel stays away past the grace as RUNNER_OFFLINE', () => {
    const down = { ...base, tunnel: { up: false, upAt: null, lostAt: NOW - grace + 1000 } };
    expect(sweepMove(down, NOW)).toBeNull();
    expect(
      sweepMove({ ...down, tunnel: { ...down.tunnel, lostAt: NOW - grace - 1 } }, NOW),
    ).toMatchObject({ to: 'failed', reason: 'RUNNER_OFFLINE' });
  });

  it('tells a box that predates previews from one that is offline', () => {
    const starting = {
      ...base,
      state: 'starting' as const,
      startedAt: NOW - grace - 1,
      tunnel: { up: false, upAt: null, lostAt: null },
    };
    expect(sweepMove(starting, NOW)).toMatchObject({ reason: 'RUNNER_CANNOT_PREVIEW' });
    expect(sweepMove({ ...starting, boxConnected: false }, NOW)).toMatchObject({
      reason: 'RUNNER_OFFLINE',
    });
    expect(sweepMove({ ...starting, startedAt: NOW - 1000 }, NOW)).toBeNull();
  });

  it('fails a start the box never answered as DEV_SERVER_NOT_LISTENING', () => {
    const silent = {
      ...base,
      state: 'starting' as const,
      startedAt:
        NOW - (PREVIEW_LIMITS.readyTimeoutSeconds + PREVIEW_LIMITS.tunnelGraceSeconds) * 1000 - 1,
    };
    expect(sweepMove(silent, NOW)).toMatchObject({ reason: 'DEV_SERVER_NOT_LISTENING' });
  });
});
