import { describe, it } from 'vitest';
import { clone, type Doc, expectAccepted, expectRefused, read } from './schema.fixture.js';

const p = read('sim-forge-dev/project.json');
const pol = read('sim-forge-dev/policy.json');
const t = read('sim-forge-dev/testing.beta.json');
const st = read('sim-forge-dev/state.dev.json');
const withP = (f: (d: Doc) => void) => {
  const d = clone(p);
  f(d);
  return d;
};
const withPol = (f: (d: Doc) => void) => {
  const d = clone(pol);
  f(d);
  return d;
};
const withT = (f: (d: Doc) => void) => {
  const d = clone(t);
  f(d);
  return d;
};
const n = <T>(count: number, f: (i: number) => T): T[] =>
  Array.from({ length: count }, (_, i) => f(i));
const envs = (count: number) =>
  Object.fromEntries(
    n(count, (i) => `e${i}`).map((k) => [
      k,
      { tier: 'dev', deploysFrom: 'main', deployment: { mode: 'external' } },
    ]),
  );

describe('boundaries: git refs', () => {
  it('source.git.branches: 1 and 10 accepted, 0, 11 and a duplicate refused', () => {
    expectAccepted(
      'project',
      withP((d) => {
        d.source.git.branches = ['main'];
      }),
    );
    expectAccepted(
      'project',
      withP((d) => {
        d.source.git.branches = n(10, (i) => `b${i}`);
      }),
    );
    expectRefused(
      'project',
      withP((d) => {
        d.source.git.branches = [];
      }),
      { path: '/source/git/branches', code: 'too_small' },
    );
    expectRefused(
      'project',
      withP((d) => {
        d.source.git.branches = n(11, (i) => `b${i}`);
      }),
      { path: '/source/git/branches', code: 'too_big' },
    );
    expectRefused(
      'project',
      withP((d) => {
        d.source.git.branches = ['main', 'main'];
      }),
      { path: '/source/git/branches', code: 'custom' },
    );
  });
  it('git ref: 200 chars accepted; 201, leading /, trailing /, //, .., @{ and .lock refused', () => {
    const at = { path: '/source/git/defaultBranch' };
    expectAccepted(
      'project',
      withP((d) => {
        d.source.git.defaultBranch = 'r'.repeat(200);
      }),
    );
    for (const bad of ['r'.repeat(201), '/main', 'main/', 'a//b', 'a..b', 'a@{b', 'main.lock']) {
      expectRefused(
        'project',
        withP((d) => {
          d.source.git.defaultBranch = bad;
        }),
        at,
      );
    }
    expectAccepted(
      'project',
      withP((d) => {
        d.source.git.defaultBranch = 'release/v1.2';
      }),
    );
  });
});

describe('boundaries: collection sizes', () => {
  it('environments: 0 and 10 accepted, 11 refused', () => {
    expectAccepted(
      'project',
      withP((d) => {
        d.environments = {};
      }),
    );
    expectAccepted(
      'project',
      withP((d) => {
        d.environments = envs(10);
      }),
    );
    expectRefused(
      'project',
      withP((d) => {
        d.environments = envs(11);
      }),
      { path: '/environments', code: 'custom' },
    );
  });
  it('promotions: 0 and 5 accepted, 6 and a duplicate refused', () => {
    const promo = (i: number) => ({ from: `f${i}`, to: `t${i}`, via: 'merge' });
    expectAccepted(
      'project',
      withP((d) => {
        d.promotions = [];
      }),
    );
    expectAccepted(
      'project',
      withP((d) => {
        d.promotions = n(5, (i) => String(i)).map((_, i) => promo(i));
      }),
    );
    expectRefused(
      'project',
      withP((d) => {
        d.promotions = n(6, (i) => String(i)).map((_, i) => promo(i));
      }),
      { path: '/promotions', code: 'too_big' },
    );
    expectRefused(
      'project',
      withP((d) => {
        d.promotions = [promo(0), promo(0)];
      }),
      { path: '/promotions', code: 'custom' },
    );
  });
  it('services: 10 accepted, 11 refused', () => {
    const svc = (count: number) =>
      Object.fromEntries(n(count, (i) => `s${i}`).map((k) => [k, 'https://x.example']));
    expectAccepted(
      'project',
      withP((d) => {
        d.environments.dev.services = svc(10);
      }),
    );
    expectRefused(
      'project',
      withP((d) => {
        d.environments.dev.services = svc(11);
      }),
      { path: '/environments/dev/services', code: 'custom' },
    );
  });
  it('verification.runtime: 1 and 3 accepted, 0 and 4 refused', () => {
    const probe = p.environments.dev.verification.runtime[0];
    expectAccepted(
      'project',
      withP((d) => {
        d.environments.dev.verification.runtime = [probe, probe, probe];
      }),
    );
    expectRefused(
      'project',
      withP((d) => {
        d.environments.dev.verification.runtime = [];
      }),
      { path: '/environments/dev/verification/runtime', code: 'too_small' },
    );
    expectRefused(
      'project',
      withP((d) => {
        d.environments.dev.verification.runtime = [probe, probe, probe, probe];
      }),
      { path: '/environments/dev/verification/runtime', code: 'too_big' },
    );
  });
});

describe('boundaries: scalar fields', () => {
  it('project.name 1..120, slug up to 63 chars', () => {
    expectAccepted(
      'project',
      withP((d) => {
        d.project.name = 'x'.repeat(120);
      }),
    );
    expectRefused(
      'project',
      withP((d) => {
        d.project.name = 'x'.repeat(121);
      }),
      { path: '/project/name', code: 'too_big' },
    );
    expectRefused(
      'project',
      withP((d) => {
        d.project.name = '';
      }),
      { path: '/project/name', code: 'too_small' },
    );
    expectAccepted(
      'project',
      withP((d) => {
        d.project.slug = `a${'b'.repeat(62)}`;
      }),
    );
    expectRefused(
      'project',
      withP((d) => {
        d.project.slug = `a${'b'.repeat(63)}`;
      }),
      { path: '/project/slug' },
    );
  });
  it('execution.plugin.ref is exactly 40 lowercase hex', () => {
    const at = { path: '/execution/plugin/ref' };
    expectRefused(
      'project',
      withP((d) => {
        d.execution.plugin.ref = 'a'.repeat(39);
      }),
      at,
    );
    expectRefused(
      'project',
      withP((d) => {
        d.execution.plugin.ref = 'a'.repeat(41);
      }),
      at,
    );
    expectRefused(
      'project',
      withP((d) => {
        d.execution.plugin.ref = 'A'.repeat(40);
      }),
      at,
    );
    expectRefused(
      'project',
      withP((d) => {
        d.execution.plugin.ref = 'main';
      }),
      at,
    );
  });
  it('version is exactly 1', () => {
    expectRefused(
      'project',
      withP((d) => {
        d.version = 2;
      }),
      { path: '/version', code: 'invalid_value' },
    );
  });
});

describe('boundaries: policy, testing profile and state', () => {
  it('policy.permissions: 1 and 10 accepted, 0 and 11 refused; deny up to 100; states not empty', () => {
    const profiles = (count: number) =>
      Object.fromEntries(
        n(count, (i) => (i === 0 ? 'development' : `p${i}`)).map((k) => [k, { deny: [] }]),
      );
    expectAccepted(
      'policy',
      withPol((d) => {
        d.permissions = profiles(10);
      }),
    );
    expectRefused(
      'policy',
      withPol((d) => {
        d.permissions = {};
      }),
      { path: '/permissions', code: 'custom' },
    );
    expectRefused(
      'policy',
      withPol((d) => {
        d.permissions = profiles(11);
      }),
      { path: '/permissions', code: 'custom' },
    );
    expectAccepted(
      'policy',
      withPol((d) => {
        d.permissions.development.deny = n(100, (i) => `c${i}`);
      }),
    );
    expectRefused(
      'policy',
      withPol((d) => {
        d.permissions.development.deny = n(101, (i) => `c${i}`);
      }),
      { path: '/permissions/development/deny', code: 'too_big' },
    );
    expectRefused(
      'policy',
      withPol((d) => {
        d.states = {};
      }),
      { path: '/states', code: 'custom' },
    );
  });
  it('testing profile: 20 actors, 30 limits, 500-char note', () => {
    const actors = (count: number) =>
      Object.fromEntries(
        n(count, (i) => `a${i}`).map((k) => [k, { role: 'viewer', credential: 'secret://x/y' }]),
      );
    const limits = (count: number) => n(count, (i) => ({ id: `l${i}`, note: 'n' }));
    expectAccepted(
      'testing-profile',
      withT((d) => {
        d.actors = actors(20);
      }),
    );
    expectRefused(
      'testing-profile',
      withT((d) => {
        d.actors = actors(21);
      }),
      { path: '/actors', code: 'custom' },
    );
    expectAccepted(
      'testing-profile',
      withT((d) => {
        d.limits = limits(30);
      }),
    );
    expectRefused(
      'testing-profile',
      withT((d) => {
        d.limits = limits(31);
      }),
      { path: '/limits', code: 'too_big' },
    );
    expectAccepted(
      'testing-profile',
      withT((d) => {
        d.limits[0].note = 'n'.repeat(500);
      }),
    );
    expectRefused(
      'testing-profile',
      withT((d) => {
        d.limits[0].note = 'n'.repeat(501);
      }),
      { path: '/limits/0/note', code: 'too_big' },
    );
  });
  it('source.revision is 7..40 hex', () => {
    const rev = (revision: string) => ({ ...clone(st), source: { kind: 'revision', revision } });
    expectAccepted('environment-state', rev('a'.repeat(7)));
    expectRefused('environment-state', rev('a'.repeat(6)), { path: '/source/revision' });
    expectRefused('environment-state', rev('a'.repeat(41)), { path: '/source/revision' });
    expectAccepted('environment-state', { ...clone(st), artifact: null, release: null });
  });
  it('source is a revision, unrecorded, or non-git, and never null', () => {
    expectAccepted('environment-state', { ...clone(st), source: { kind: 'unrecorded' } });
    expectAccepted('environment-state', { ...clone(st), source: { kind: 'non-git' } });
    expectRefused('environment-state', { ...clone(st), source: null }, { path: '/source' });
    expectRefused(
      'environment-state',
      { ...clone(st), source: { kind: 'unrecorded', revision: 'a'.repeat(7) } },
      { path: '/source', key: 'revision' },
    );
  });
});
