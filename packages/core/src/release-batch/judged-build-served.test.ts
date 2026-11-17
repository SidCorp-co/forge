// @direct-test-of packages/core/src/release-batch/judged-build.ts
// @direct-test-of packages/core/src/release-batch/served-over.ts
// ISS-1259 (FB-691): forge-dev deploys every push, so ISS-1258's judge was sent at 0.4.0-dev.702
// (caa42c35) while `dev` served 0.4.0-dev.703 (083325c7). judged-build said "production serves
// 083325c7…, and no release Forge verified there holds this issue" and nothing more: one judge recorded
// at the release head by its own reading, another stopped. It now says whether the served build
// descends from the release head with no added commit touching the issue's files, and names the
// environment as the project's document does.

import { describe, expect, it } from 'vitest';
import { type Carriage, carriageKey } from '../issues/index.js';
import { type JudgedBuildDeps, judgedBuildOf } from './judged-build.js';
import type { KeptRange } from './shipped-range.js';
import type { ShippedReleaseRun } from './shipped-releases.js';

const sha = (c: string) => c.repeat(40);
const HEAD = sha('a');
const LIVE = sha('b');
const LANDING = sha('c');
const FILE = 'packages/core/src/references/follow.ts';

const ISSUE = {
  id: 'iss-1258',
  projectId: 'forge',
  mergedAt: new Date(),
  mergedCommitSha: LANDING,
  mergedPaths: {
    read: 'box' as const,
    commit: LANDING,
    changes: [{ path: FILE, change: 'changed' as const }],
  },
};

const release = (version: string, commit: string, issueIds: string[]): ShippedReleaseRun => ({
  runId: `run-${version}`,
  version,
  commit,
  issueIds,
  cutAt: new Date('2026-11-16T00:00:00Z'),
});
const DEV_702 = release('0.4.0-dev.702', HEAD, ['iss-1258']);
const DEV_703 = release('0.4.0-dev.703', LIVE, ['iss-1260']);

function deps(opts: {
  served?: string;
  releases?: ShippedReleaseRun[];
  ranges?: Record<string, KeptRange>;
  kept?: Record<string, Carriage>;
}): JudgedBuildDeps {
  return {
    served: async () => ({ ok: true, value: opts.served ?? LIVE }),
    releases: async () => opts.releases ?? [DEV_702, DEV_703],
    ancestry: async () => ({ kind: 'none', why: 'no source host and no box' }),
    withdrawn: async () => false,
    environment: async () => 'dev',
    ranges: async (ids) =>
      new Map(ids.flatMap((id) => (opts.ranges?.[id] ? [[id, opts.ranges[id]] as const] : []))),
    heldAncestry: async (_p, judged, served) => {
      const out = new Map<string, Carriage>();
      for (const j of judged)
        for (const s of served) {
          const answer = opts.kept?.[carriageKey(j, s)];
          if (answer) out.set(carriageKey(j, s), answer);
        }
      return out;
    },
  };
}

const range = (changed: string[], base = HEAD, head = LIVE): KeptRange => ({
  base,
  head,
  changed: changed.map((path) => ({ path, change: 'changed' as const })),
});

describe('a served build other than the release head (ISS-1259)', () => {
  it('carries the change unchanged where it descends and its added commits touch none of the issue files', async () => {
    const built = await judgedBuildOf(
      ISSUE,
      deps({ ranges: { 'run-0.4.0-dev.703': range(['packages/core/src/other.ts']) } }),
    );
    expect(built).toMatchObject({ sha: HEAD, source: 'shipped', version: '0.4.0-dev.702' });
    expect(built.served).toEqual({
      environment: 'dev',
      sha: LIVE,
      carries: 'unchanged',
      touched: [],
      why: expect.stringContaining("carries this issue's change unchanged"),
    });
    expect(built.basis).toContain(`\`dev\` serves \`${LIVE}\``);
    expect(built.basis).not.toContain('production');
  });

  it('is touched where an added commit changes one of the issue files, naming it', async () => {
    const built = await judgedBuildOf(
      ISSUE,
      deps({ ranges: { 'run-0.4.0-dev.703': range(['packages/core/src/other.ts', FILE]) } }),
    );
    expect(built.served).toMatchObject({ carries: 'touched', touched: [FILE] });
    expect(built.served?.why).toContain(`\`${FILE}\``);
  });

  it('chains every release between the head and the served one, and reads unread where one kept no range', async () => {
    const DEV_704 = release('0.4.0-dev.704', sha('d'), []);
    const releases = [DEV_702, DEV_703, DEV_704];
    const chained = await judgedBuildOf(
      ISSUE,
      deps({
        served: DEV_704.commit,
        releases,
        ranges: {
          'run-0.4.0-dev.703': range(['x.ts']),
          'run-0.4.0-dev.704': range([FILE], LIVE, DEV_704.commit),
        },
      }),
    );
    expect(chained.served).toMatchObject({ carries: 'touched', touched: [FILE] });
    const gap = await judgedBuildOf(
      ISSUE,
      deps({ served: DEV_704.commit, releases, ranges: { 'run-0.4.0-dev.703': range(['x.ts']) } }),
    );
    expect(gap.served).toMatchObject({ carries: 'unread' });
    expect(gap.served?.why).toContain('release 0.4.0-dev.704 kept no reading');
  });

  it('is no descendant where the served release shipped before the head, or the host answered it differs', async () => {
    const before = await judgedBuildOf(
      ISSUE,
      deps({ releases: [release('0.4.0-dev.701', LIVE, []), DEV_702] }),
    );
    expect(before.served).toMatchObject({ carries: 'not-descendant' });
    const differs = await judgedBuildOf(
      ISSUE,
      deps({
        releases: [DEV_702],
        kept: { [carriageKey(HEAD, LIVE)]: { kind: 'differs', paths: [FILE] } },
      }),
    );
    expect(differs.served).toMatchObject({ carries: 'not-descendant' });
  });

  it('says by name what it cannot read: a served build no release recorded, or a mark naming no files', async () => {
    const unreleased = await judgedBuildOf(ISSUE, deps({ releases: [DEV_702] }));
    expect(unreleased.served).toMatchObject({ carries: 'unread' });
    expect(unreleased.served?.why).toContain(`\`${LIVE}\` is no release Forge verified`);
    const descends = await judgedBuildOf(
      ISSUE,
      deps({ releases: [DEV_702], kept: { [carriageKey(HEAD, LIVE)]: { kind: 'descends' } } }),
    );
    expect(descends.served).toMatchObject({ carries: 'unread' });
    expect(descends.served?.why).toContain('no kept release range');
    const unmarked = await judgedBuildOf(
      { ...ISSUE, mergedPaths: null },
      deps({ ranges: { 'run-0.4.0-dev.703': range([]) } }),
    );
    expect(unmarked.served).toMatchObject({ carries: 'unread' });
    expect(unmarked.served?.why).toContain('names none of the files');
  });

  it('says nothing of a served build where the served build is the head', async () => {
    const built = await judgedBuildOf(ISSUE, deps({ served: HEAD }));
    expect(built).toMatchObject({ sha: HEAD, source: 'live' });
    expect(built.served).toBeUndefined();
    expect(built.basis).toBe('`dev` serves release 0.4.0-dev.702, which shipped this issue');
  });
});
