// ISS-964: where a release weighs criteria turns on whether any environment the project judges on can
// serve a landed change before its release. No trigger answers it, so production's reading does:
// agenfold's on-land production, serving only what its releases shipped, held draft 0.125.0 for
// verdicts at the 0.123.0 build for ever.
// @direct-test-of packages/core/src/release-batch/criteria-basis.ts

import { describe, expect, it } from 'vitest';
import type { ReleasePath } from '../project-config/index.js';
import { basisOfPath, landingWhere, servedNamed, servingWhere } from './criteria-basis.js';

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

const TRIGGERS = [
  ['on-land', binding('on-land')],
  ['on-request', binding('on-request')],
  ['provider', binding('provider')],
  ['external', { mode: 'external' } as const],
] as const;

describe('where a project weighs its criteria, for every trigger (ISS-964)', () => {
  it.each(TRIGGERS)(
    'weighs a %s production serving only what its releases shipped at the landing',
    (deployment, declared) => {
      expect(basisOfPath(path(declared), 'releases')).toEqual({
        kind: 'landing',
        why: 'release-only',
        landsOn: 'main',
        deploysFrom: 'main',
        byRecord: false,
        deployment,
      });
    },
  );

  it.each(TRIGGERS)(
    'weighs a %s production a landing reached at what it serves, and keeps it where the reading says nothing',
    (_, declared) => {
      for (const moves of ['lands', 'unread', 'none'] as const) {
        expect(basisOfPath(path(declared), moves)).toEqual({
          kind: 'serving',
          why: 'landing-reaches',
          judgedOn: null,
        });
      }
    },
  );

  it('weighs a production naming no commit at the landing where nothing answers (ISS-957)', () => {
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

  it('weighs at what the judged-on environment serves, whatever production serves', () => {
    for (const [, declared] of TRIGGERS) {
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
  const landing = (declared: Deployment, probe = true) => {
    const basis = basisOfPath(path(declared, { probe }), probe ? 'releases' : 'unread');
    if (basis.kind !== 'landing') throw new Error('not a landing basis');
    return landingWhere(basis);
  };

  it('says production moves only by a release, by what it serves, never that it names no commit where it does', () => {
    const words = landing(binding('on-land'));
    expect(words).toContain(
      'production is deployed only by a release (`on-land`: it serves only what its releases shipped while a change landed since waits)',
    );
    expect(words).not.toContain('names no commit');
    expect(landing({ mode: 'external' })).toContain('(deployed outside Forge: it serves only');
  });

  it('says a production naming no commit is read on its release record', () => {
    expect(landing(binding('on-land'), false)).toContain('it names no commit it serves');
  });

  it('says what is served and why, for production and for a judged-on environment', () => {
    expect(servingWhere(null)).toContain("what this project's production serves, as on a project");
    expect(servingWhere('stg')).toContain('`stg` serves');
  });

  it('says what a served commit is by the releases recorded, never that no release shipped it (ISS-997)', () => {
    const at = (commit: string) =>
      ({
        kind: 'serving',
        served: [{ commit, where: 'prod' }],
        unread: [],
        readAt: 'now',
      }) as const;
    const releases = [
      { runId: 'r1', version: '0.138.0', commit: 'a'.repeat(40) },
      { runId: 'r2', version: '0.139.0', commit: 'a'.repeat(40) },
    ];
    const shipped = servingWhere(null, servedNamed(at('a'.repeat(40)), releases));
    expect(shipped).toContain('(the commit release 0.139.0 shipped)');
    expect(shipped).not.toContain('no release');
    expect(servedNamed(at('aaaaaaa'), releases)).toBe('the commit release 0.139.0 shipped');
    expect(servedNamed(at('c'.repeat(40)), releases)).toBe('a commit no release names');
    expect(servedNamed({ kind: 'unreadable', why: 'x', hosts: [], readAt: 'now' }, releases)).toBe(
      undefined,
    );
  });
});
