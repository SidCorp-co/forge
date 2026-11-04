// ISS-964: where a release weighs criteria turns on whether any environment the project judges on can
// serve a landed change before its release, read per trigger: agenfold's on-land production, serving
// only what its releases shipped, held draft 0.125.0 for verdicts at the 0.123.0 build for ever.
// @direct-test-of packages/core/src/release-batch/criteria-basis.ts

import { describe, expect, it } from 'vitest';
import type { ReleasePath } from '../project-config/index.js';
import { basisOfPath, landingWhere, servingWhere } from './criteria-basis.js';

type Deployment =
  | { binding: string; trigger: 'on-land' | 'on-request' | 'provider' }
  | { mode: 'external' };

const PROBE = {
  runtime: [
    {
      type: 'http' as const,
      url: 'https://app.example.test/healthz',
      path: 'commit',
      identifies: 'source' as const,
    },
  ],
};

function path(
  deployment: Deployment | null,
  over: { judgedOn?: string; probe?: boolean; crossing?: boolean } = {},
): ReleasePath {
  const production = deployment
    ? {
        name: 'production',
        declaration: {
          tier: 'production',
          deploysFrom: 'main',
          deployment,
          ...(over.probe === false ? {} : { verification: PROBE }),
        },
      }
    : null;
  return {
    revision: 1,
    document: { delivery: over.judgedOn ? { judgedOn: over.judgedOn } : {} },
    defaultBranch: 'main',
    production,
    crossing: over.crossing ? { from: 'main', to: 'release', via: 'merge' } : null,
  } as unknown as ReleasePath;
}

const binding = (trigger: 'on-land' | 'on-request' | 'provider') => ({ binding: 'b-1', trigger });

describe('where a project weighs its criteria, per trigger (ISS-964)', () => {
  it.each([
    ['on-request', binding('on-request')],
    ['provider', binding('provider')],
    ['external', { mode: 'external' } as const],
  ])(
    'weighs a %s production at the landing, whatever its reading names',
    (deployment, declared) => {
      for (const moves of ['releases', 'lands', 'unread', 'none'] as const) {
        expect(basisOfPath(path(declared), moves)).toEqual({
          kind: 'landing',
          why: 'release-only',
          landsOn: 'main',
          deploysFrom: 'main',
          byRecord: false,
          deployment,
        });
      }
    },
  );

  it('weighs an on-land production that serves only what its releases shipped at the landing', () => {
    expect(basisOfPath(path(binding('on-land')), 'releases')).toMatchObject({
      kind: 'landing',
      why: 'release-only',
      deployment: 'on-land',
      byRecord: false,
    });
  });

  it('weighs an on-land production a landing reached at what it serves, and keeps the declaration where the reading says nothing', () => {
    for (const moves of ['lands', 'unread', 'none'] as const) {
      expect(basisOfPath(path(binding('on-land')), moves)).toEqual({
        kind: 'serving',
        why: 'on-land',
        judgedOn: null,
      });
    }
  });

  it('weighs an on-land production naming no commit at the landing where nothing answers (ISS-957)', () => {
    expect(basisOfPath(path(binding('on-land'), { probe: false }), 'unread')).toMatchObject({
      kind: 'landing',
      why: 'release-only',
      byRecord: true,
    });
    // a deployment that names what it serves, though no probe does, is a reading like any other
    expect(basisOfPath(path(binding('on-land'), { probe: false }), 'lands')).toMatchObject({
      kind: 'serving',
    });
  });

  it('weighs at what the judged-on environment serves, whatever the trigger', () => {
    for (const declared of [
      binding('on-land'),
      binding('on-request'),
      { mode: 'external' } as const,
    ]) {
      expect(basisOfPath(path(declared, { judgedOn: 'stg' }), 'releases')).toEqual({
        kind: 'serving',
        why: 'judged-on',
        judgedOn: 'stg',
      });
    }
  });

  it('keeps a promotion at the landing, and a project with no production at what it serves', () => {
    expect(basisOfPath(path(binding('on-land'), { crossing: true }), 'lands')).toMatchObject({
      kind: 'landing',
      why: 'promotion',
      landsOn: 'main',
      deploysFrom: 'release',
      deployment: null,
    });
    expect(basisOfPath(path(null), 'none')).toEqual({
      kind: 'serving',
      why: 'no-production',
      judgedOn: null,
    });
  });
});

describe('the words a hold names its basis in', () => {
  it('says production moves only by a release, and how, never that it names no commit where it does', () => {
    const basis = basisOfPath(path(binding('on-land')), 'releases');
    if (basis.kind !== 'landing') throw new Error('not a landing basis');
    const words = landingWhere(basis);
    expect(words).toContain('production is deployed only by a release');
    expect(words).toContain('every commit it serves is one a release shipped');
    expect(words).not.toContain('names no commit');
  });

  it('names the trigger of each production deployed only by a release', () => {
    const said = (declared: Deployment) => {
      const basis = basisOfPath(path(declared), 'none');
      if (basis.kind !== 'landing') throw new Error('not a landing basis');
      return landingWhere(basis);
    };
    expect(said(binding('on-request'))).toContain('`on-request` trigger');
    expect(said(binding('provider'))).toContain('`provider` trigger');
    expect(said({ mode: 'external' })).toContain('deployed outside Forge');
  });

  it('says what is served and why, for production and for a judged-on environment', () => {
    expect(servingWhere(null)).toContain('which deploys on land');
    expect(servingWhere('stg')).toContain('`stg` serves');
  });
});
