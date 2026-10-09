import { PREVIEW_LIMITS } from '@forge/contracts/preview';
import { describe, expect, it } from 'vitest';
import {
  previewPlan,
  roomLanding,
  type RunFacts,
  runEndedWhy,
  type SweepFacts,
  stateRefusal,
  sweepMove,
} from './rules.js';

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
        seed: null,
        data: 'environment',
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
    expect(planned).toEqual({
      ok: true,
      plan: { settings: null, env: { FORGE_PREVIEW: '1' }, seed: null, data: 'environment' },
    });
  });
});

describe('previewPlan for a reproduce: demo data where the project names it, else its environment (REQ-41 BC-22)', () => {
  const environments = {
    dev: { tier: 'dev' as const, deployment: external, url: 'https://dev.example.test' },
    demo: { tier: 'staging' as const, deployment: external, url: 'https://demo.example.test' },
    live: { tier: 'production' as const, deployment: external },
  };

  it('talks to the demo environment and seeds it first, where `preview.demo` names them', () => {
    const planned = previewPlan(
      {
        preview: {
          command: 'pnpm dev',
          port: 3000,
          demo: { environment: 'demo', seed: 'pnpm seed' },
        },
        environments,
      },
      'reproduce',
    );
    expect(planned.ok && planned.plan).toMatchObject({
      env: { FORGE_ENVIRONMENT: 'demo', FORGE_ENVIRONMENT_URL: 'https://demo.example.test' },
      seed: 'pnpm seed',
    });
    // an issue's run is never seeded and keeps its own environment
    const issue = previewPlan(
      { preview: { command: 'pnpm dev', port: 3000, demo: { seed: 'pnpm seed' } }, environments },
      'issue',
    );
    expect(issue.ok && issue.plan).toMatchObject({ env: { FORGE_ENVIRONMENT: 'dev' }, seed: null });
  });

  it("a POC room's idea runs on the demo data a reproduce would, and says so (REQ-44 BC-12)", () => {
    const document = {
      preview: { command: 'pnpm dev', port: 3000, demo: { seed: 'pnpm seed' } },
      environments,
    };
    const room = previewPlan(document, 'idea', true);
    expect(room.ok && room.plan).toMatchObject({ seed: 'pnpm seed', data: 'demo' });
    // an idea outside a room keeps the dev environment, unseeded
    const idea = previewPlan(document, 'idea');
    expect(idea.ok && idea.plan).toMatchObject({ seed: null, data: 'environment' });
    // a room in a project that names no demo data says it runs on the dev environment
    const bare = previewPlan({ environments }, 'idea', true);
    expect(bare.ok && bare.plan).toMatchObject({ seed: null, data: 'environment' });
  });

  it('falls back to the environment its dev server uses when no demo is named', () => {
    const planned = previewPlan({ environments }, 'reproduce');
    expect(planned.ok && planned.plan).toMatchObject({
      env: { FORGE_ENVIRONMENT: 'dev' },
      seed: null,
    });
  });

  it('refuses a production demo by name, at the demo setting', () => {
    const planned = previewPlan(
      { preview: { command: 'pnpm dev', port: 3000, demo: { environment: 'live' } }, environments },
      'reproduce',
    );
    expect(planned.ok ? null : planned.refusal).toMatchObject({
      code: 'PREVIEW_PRODUCTION_ENVIRONMENT',
      path: '/preview/demo/environment',
    });
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

describe('runEndedWhy: what ends a preview with its run (REQ-41 BC-14, REQ-39 BC-9)', () => {
  const none: RunFacts = {
    sessionStatus: 'running',
    checkoutReleased: false,
    sessionClosedOnBox: false,
  };

  it("ends an issue's preview with its run's session, naming the status", () => {
    expect(runEndedWhy('issue', { ...none, sessionStatus: 'completed' })).toBe(
      'the run holding the worktree ended: its session is completed',
    );
    expect(runEndedWhy('issue', { ...none, sessionClosedOnBox: true })).toMatch(/box reports/);
    expect(runEndedWhy('issue', none)).toBeNull();
  });

  it("does not end an idea's or a reproduce's preview with a completed turn", () => {
    for (const kind of ['idea', 'reproduce'] as const) {
      for (const status of ['completed', 'failed', 'cancelled', 'completed_via_recovery']) {
        expect(runEndedWhy(kind, { ...none, sessionStatus: status })).toBeNull();
      }
      expect(runEndedWhy(kind, { ...none, sessionClosedOnBox: true })).toBeNull();
    }
  });

  it('ends any preview whose box reports the checkout released', () => {
    for (const kind of ['issue', 'idea', 'reproduce'] as const) {
      expect(runEndedWhy(kind, { ...none, checkoutReleased: true })).toMatch(
        /box reports the checkout released/,
      );
    }
  });
});

describe('roomLanding: the dev branch a settled POC room merges into (REQ-44 BC-2)', () => {
  const doc = (defaultBranch: string, ...deploysFrom: string[]) =>
    ({
      source: { type: 'git', git: { repository: 'r', defaultBranch, branches: [defaultBranch] } },
      environments: Object.fromEntries(
        deploysFrom.map((from, i) => [`live${i}`, { tier: 'production', deploysFrom: from }]),
      ),
    }) as never;

  it('merges into a dev branch production does not deploy from', () => {
    expect(roomLanding(doc('dev', 'main'))).toEqual({ ok: true, into: 'dev' });
  });

  it('refuses main by its name even where production deploys from another branch', () => {
    expect(roomLanding(doc('main', 'release'))).toMatchObject({
      ok: false,
      code: 'ROOM_PRODUCTION_BRANCH',
    });
  });

  it('refuses a branch any production environment deploys from, not only the first', () => {
    const refused = roomLanding(doc('dev', 'main', 'dev'));
    expect(refused).toMatchObject({ ok: false, code: 'ROOM_PRODUCTION_BRANCH' });
    expect(JSON.stringify(refused)).toContain('live1');
  });

  it('refuses a project with no git source by name', () => {
    expect(roomLanding(null)).toMatchObject({ ok: false, code: 'ROOM_NO_DEV_BRANCH' });
  });
});
