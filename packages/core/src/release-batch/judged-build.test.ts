// The live QA of dev.192/193 (REQ-6 BC-2, BC-4): the Judge never pre-filled the live commit, even on
// ISS-432, which release 0.4.0-dev.192 shipped while production served that release. The web read
// a default only from a promotion reach (none on a project deploying the branch it lands on) or the
// issue's merge sha (null on every forge-dev mark), never from the release that shipped the issue.
// Here the default is read from the build production serves and the releases Forge verified.

import { describe, expect, it } from 'vitest';
import { type JudgedBuildDeps, judgedBuildOf, liveBuildHolds } from './judged-build.js';
import type { AncestrySource, ShippedReleaseRun } from './shipped-earlier.js';
import type { AncestryReader } from './shipped-earlier-ancestry.js';

const sha = (c: string) => c.repeat(40);
const ISSUE = { id: 'iss-432', projectId: 'p1', mergedAt: new Date(), mergedCommitSha: null };

const release = (version: string, commit: string, issueIds: string[]): ShippedReleaseRun => ({
  runId: `run-${version}`,
  version,
  commit,
  issueIds,
});

const DEV_192 = release('0.4.0-dev.192', sha('a'), ['iss-432']);
const DEV_193 = release('0.4.0-dev.193', sha('b'), ['iss-443']);

/** A reader answering each pair from `ancestors` (`commit@release`), and counting what it was asked. */
function reader(ancestors: Record<string, boolean | { unread: string }>) {
  const asked: string[] = [];
  const r: AncestryReader = {
    async ask(pairs) {
      const out = new Map<string, boolean | { unread: string }>();
      for (const p of pairs) {
        const key = `${p.commit}@${p.release}`;
        asked.push(key);
        out.set(key, ancestors[key] ?? { unread: 'not planted' });
      }
      return out;
    },
    witness: () => ({ via: 'source-host' }),
  };
  return { asked, source: { kind: 'box', why: 'no host', reader: r } as AncestrySource };
}

function deps(
  served: string | { why: string },
  releases: ShippedReleaseRun[],
  ancestry: AncestrySource = { kind: 'none', why: 'no source host and no box' },
): JudgedBuildDeps {
  return {
    served: async () =>
      typeof served === 'string' ? { ok: true, value: served } : { ok: false, why: served.why },
    releases: async () => releases,
    ancestry: async () => ancestry,
    withdrawn: async () => false,
  };
}

describe('the build a verdict defaults to', () => {
  it('is the live build where production serves the release that shipped the issue (ISS-432 on dev.192)', async () => {
    const built = await judgedBuildOf(ISSUE, deps(DEV_192.commit, [DEV_192]));
    expect(built).toMatchObject({ sha: DEV_192.commit, source: 'live', version: '0.4.0-dev.192' });
  });

  it('is the live build where the shipping release is an ancestor of what production serves', async () => {
    const r = reader({ [`${DEV_192.commit}@${DEV_193.commit}`]: true });
    const built = await judgedBuildOf(ISSUE, deps(DEV_193.commit, [DEV_192, DEV_193], r.source));
    expect(built).toMatchObject({ sha: DEV_193.commit, source: 'live', version: '0.4.0-dev.193' });
    expect(built.basis).toContain(`release 0.4.0-dev.192's commit \`${DEV_192.commit}\``);
  });

  it("is the live build where the issue's merge is an ancestor of the served commit no release names", async () => {
    const merged = sha('c');
    const served = sha('d');
    const r = reader({ [`${merged}@${served}`]: true });
    const built = await judgedBuildOf(
      { ...ISSUE, mergedCommitSha: merged.toUpperCase() },
      deps(served, [], r.source),
    );
    expect(built).toMatchObject({ sha: served, source: 'live', version: null });
  });

  it('names an abbreviated served commit by the one release it names', async () => {
    const built = await judgedBuildOf(ISSUE, deps(DEV_192.commit.slice(0, 9), [DEV_192]));
    expect(built).toMatchObject({ sha: DEV_192.commit, source: 'live' });
  });

  it('falls back to the shipping build, saying so, where production does not hold it', async () => {
    const shipped = release('0.4.0-dev.180', sha('e'), ['iss-432']);
    const served = sha('f');
    const r = reader({ [`${shipped.commit}@${served}`]: false });
    const built = await judgedBuildOf(ISSUE, deps(served, [shipped], r.source));
    expect(built).toMatchObject({
      sha: shipped.commit,
      source: 'shipped',
      version: '0.4.0-dev.180',
    });
    expect(built.basis).toContain('which does not hold it');
  });

  it('falls back to the shipping build where nobody can read the ancestry, naming why', async () => {
    const shipped = release('0.4.0-dev.181', sha('1'), ['iss-432']);
    const built = await judgedBuildOf(ISSUE, deps(sha('2'), [shipped]));
    expect(built).toMatchObject({ sha: shipped.commit, source: 'shipped' });
    expect(built.basis).toContain('no source host and no box');
  });

  it('falls back to the shipping build where the live build cannot be read', async () => {
    const built = await judgedBuildOf(ISSUE, deps({ why: 'the probe timed out' }, [DEV_192]));
    expect(built).toMatchObject({ sha: DEV_192.commit, source: 'shipped' });
    expect(built.basis).toContain('the probe timed out');
  });

  it('is the merge commit where no release shipped it and production does not hold it', async () => {
    const merged = sha('3');
    const served = sha('4');
    const r = reader({ [`${merged}@${served}`]: false });
    const built = await judgedBuildOf(
      { ...ISSUE, mergedCommitSha: merged },
      deps(served, [], r.source),
    );
    expect(built).toMatchObject({ sha: merged, source: 'merged', version: null });
  });

  // ISS-489 r4: reopened out of the release that shipped round 1, the issue's verdicts defaulted to
  // that release's build, which holds none of the work being judged now
  it('names no release a reopen took the issue back from, even the one production serves', async () => {
    const reopened = { ...deps(DEV_192.commit, [DEV_192]), withdrawn: async () => true };
    const built = await judgedBuildOf(ISSUE, reopened);
    expect(built).toMatchObject({ sha: null, source: null, version: null });
    expect(built.basis).not.toContain('0.4.0-dev.192');
  });

  it('names no build where the issue has none, never the live one by default', async () => {
    const built = await judgedBuildOf(ISSUE, deps(DEV_193.commit, [DEV_193]));
    expect(built).toMatchObject({ sha: null, source: null });
    const unmerged = await judgedBuildOf(
      { ...ISSUE, mergedAt: null },
      deps(DEV_193.commit, [DEV_193]),
    );
    expect(unmerged).toMatchObject({ sha: null, source: null });
    expect(unmerged.basis).toContain('has not merged');
  });

  it('asks the same pair once: ancestry between two commits never changes', async () => {
    const shipped = release('0.4.0-dev.182', sha('5'), ['iss-432']);
    const served = sha('6');
    const r = reader({ [`${shipped.commit}@${served}`]: true });
    await judgedBuildOf(ISSUE, deps(served, [shipped], r.source));
    await judgedBuildOf(ISSUE, deps(served, [shipped], r.source));
    expect(r.asked).toEqual([`${shipped.commit}@${served}`]);
  });
});

// coverage-truth: a requirement's coverage counts a verdict only where the live build holds the
// commit it was judged at; what production serves and each commit's ancestry are read here
// catalog-fe (feaf7d40), 2026-10-27: delivery.judgedOn = "dev". ISS-11..19 were closed by the
// f44ff116 recorded landing and passed on dev at a36f27ef, yet judged-build answered f44ff116,
// source "landed", basis "this project declares no production environment" (REQ-36 BC-18).
describe('on a project naming its testing environment (delivery.judgedOn)', () => {
  const F44 = 'f44ff116'.padEnd(40, '1');
  const A36 = 'a36f27ef'.padEnd(40, '2');
  const LANDED = {
    sha: F44,
    source: 'landed' as const,
    version: null,
    basis:
      'ISS-11 was closed by a landing record at `f44ff116`; this project declares no production environment, so its landing is the build a verdict counts on, judged at that commit',
  };
  function onDev(
    served: string | { why: string },
    ancestry: AncestrySource = { kind: 'none', why: 'no source host and no box' },
  ): JudgedBuildDeps {
    return {
      ...deps({ why: 'no production environment is declared' }, [], ancestry),
      landed: async () => LANDED,
      testing: async () => ({
        name: 'dev',
        served:
          typeof served === 'string' ? { ok: true, value: served } : { ok: false, why: served.why },
      }),
    };
  }
  const ISS_11 = { ...ISSUE, id: 'iss-11', mergedCommitSha: F44 };

  it('is the build dev serves where it holds the landing (ISS-11 at a36f27ef)', async () => {
    const r = reader({ [`${F44}@${A36}`]: true });
    const built = await judgedBuildOf(ISS_11, onDev(A36, r.source));
    expect(built).toMatchObject({ sha: A36, source: 'judged-on', version: null });
    expect(built.basis).toContain('`dev` serves');
    expect(built.basis).toContain('delivery.judgedOn');
    expect(built.basis).not.toContain('declares no production environment');
  });

  it('stays the landing where dev serves a build that does not hold it, and says so', async () => {
    // another served commit: an ancestry answer is kept for the process
    const aside = 'b47c0de0'.padEnd(40, '3');
    const r = reader({ [`${F44}@${aside}`]: false });
    const built = await judgedBuildOf(ISS_11, onDev(aside, r.source));
    expect(built).toMatchObject({ sha: F44, source: 'landed' });
    expect(built.basis).toContain(`\`dev\` serves \`${aside}\`, which does not hold it`);
  });

  it('stays the landing where what dev serves cannot be read, naming why', async () => {
    const built = await judgedBuildOf(ISS_11, onDev({ why: 'the deploy record names no commit' }));
    expect(built).toMatchObject({ sha: F44, source: 'landed' });
    expect(built.basis).toContain('the deploy record names no commit');
  });

  // with production too, production's live build is answered only where dev cannot be: a commit
  // verdict there proves no release of a project judged on dev (`judgedOnReleaseBuild`)
  const withProduction = (served: string | { why: string }, ancestry: AncestrySource) => ({
    ...deps(DEV_192.commit, [DEV_192], ancestry),
    testing: async () => ({
      name: 'dev',
      served:
        typeof served === 'string'
          ? { ok: true as const, value: served }
          : { ok: false as const, why: served.why },
    }),
  });

  it("is dev's build, not production's, where both hold the release that shipped the issue", async () => {
    const onDevNow = 'c0ffee00'.padEnd(40, '4');
    const r = reader({ [`${DEV_192.commit}@${onDevNow}`]: true });
    const built = await judgedBuildOf(ISSUE, withProduction(onDevNow, r.source));
    expect(built).toMatchObject({ sha: onDevNow, source: 'judged-on', version: null });
    expect(built.basis).toContain(`holds this issue's work \`${DEV_192.commit}\``);
  });

  it("is production's live build where dev cannot be read, naming why", async () => {
    const built = await judgedBuildOf(
      ISSUE,
      withProduction({ why: 'dev is not deployed' }, reader({}).source),
    );
    expect(built).toMatchObject({ sha: DEV_192.commit, source: 'live' });
    expect(built.basis).toContain('dev is not deployed');
  });
});

describe('what the live build holds of verdict commits', () => {
  it('answers each commit: the served one itself, an ancestor, one it lacks; an unread one is left out', async () => {
    const live = sha('9');
    const r = reader({ [`${sha('1')}@${live}`]: true, [`${sha('2')}@${live}`]: false });
    const read = await liveBuildHolds(
      'p-holds',
      { commits: [live, sha('1'), sha('2').toUpperCase(), sha('3')] },
      deps(live, [], r.source),
    );
    expect(read?.sha).toBe(live);
    expect([...(read?.holds ?? [])]).toEqual([
      [live, true],
      [sha('1'), true],
      [sha('2'), false],
    ]);
    expect(r.asked).not.toContain(`${live}@${live}`);
    expect([...(read?.unanswered ?? [])]).toEqual([
      [sha('3'), 'the ancestry reader could not answer: not planted'],
    ]);
  });

  // ISS-489 r3: a hold nobody answered was dropped with its reason, so coverage counted the verdict
  // silently; every asked commit is now answered either way or carries why it was not
  it('reads nothing where nothing is asked, and names why for every commit where production cannot be read', async () => {
    expect(await liveBuildHolds('p-none', { commits: [] }, deps(sha('9'), []))).toBeNull();
    const down = await liveBuildHolds(
      'p-down',
      { commits: [sha('1')] },
      deps({ why: 'no probe' }, []),
    );
    expect(down?.sha).toBeNull();
    expect([...(down?.holds ?? [])]).toEqual([]);
    expect([...(down?.unanswered ?? [])]).toEqual([
      [sha('1'), 'the live build could not be read: no probe'],
    ]);
    const unnamed = await liveBuildHolds(
      'p-unnamed',
      { commits: [sha('1')] },
      deps('v9.9.9', [DEV_192]),
    );
    expect([...(unnamed?.unanswered ?? [])]).toEqual([
      [sha('1'), 'production answers `v9.9.9`, which names no single release Forge verified'],
    ]);
  });

  it('names why a commit went unanswered where no reader can be asked, one is silent, or one fails', async () => {
    const live = sha('6');
    const none = await liveBuildHolds('p-noreader', { commits: [sha('1')] }, deps(live, []));
    expect([...(none?.unanswered ?? [])]).toEqual([
      [sha('1'), 'no ancestry reader can be asked: no source host and no box'],
    ]);
    const silent: AncestryReader = {
      ask: async () => ({ silent: 'the box holding the checkout is offline' }),
      witness: () => ({ via: 'source-host' }),
    };
    const quiet = await liveBuildHolds(
      'p-silent',
      { commits: [sha('2')] },
      deps(live, [], { kind: 'box', why: 'no host', reader: silent }),
    );
    expect([...(quiet?.unanswered ?? [])]).toEqual([
      [sha('2'), 'the ancestry reader did not answer: the box holding the checkout is offline'],
    ]);
    const failing: AncestryReader = {
      ask: async () => {
        throw new Error('socket hang up');
      },
      witness: () => ({ via: 'source-host' }),
    };
    const failed = await liveBuildHolds(
      'p-failing',
      { commits: [sha('3')] },
      deps(live, [], { kind: 'box', why: 'no host', reader: failing }),
    );
    expect(failed?.holds.size).toBe(0);
    expect([...(failed?.unanswered ?? [])]).toEqual([
      [sha('3'), 'the ancestry reader failed: socket hang up'],
    ]);
  });

  // ISS-489 r2: a runtime-identity verdict reached coverage with no commit, so it was never checked
  // against the live build and a pass counted; each runtime now resolves to the commit it served
  it('resolves each runtime to the commit that build served and asks the live build about it', async () => {
    const live = sha('7');
    const r = reader({ [`${sha('5')}@${live}`]: false });
    const digest = 'd'.repeat(64);
    const read = await liveBuildHolds(
      'p-runtime',
      { commits: [], runtimes: [live.toUpperCase(), sha('5'), digest] },
      deps(live, [DEV_192], r.source),
    );
    expect([...(read?.runtimes ?? [])]).toEqual([
      [live, live],
      [sha('5'), sha('5')],
      [digest, null],
    ]);
    expect([...(read?.holds ?? [])]).toEqual([
      [live, true],
      [sha('5'), false],
    ]);
  });

  it('resolves runtimes from the verified releases even where production cannot be read', async () => {
    const read = await liveBuildHolds(
      'p-runtime-down',
      { commits: [], runtimes: [DEV_192.commit] },
      deps({ why: 'no probe' }, [DEV_192]),
    );
    expect(read).toEqual({
      sha: null,
      holds: new Map(),
      runtimes: new Map([[DEV_192.commit, DEV_192.commit]]),
      unanswered: new Map([[DEV_192.commit, 'the live build could not be read: no probe']]),
    });
  });

  it('keeps an answer, so the same pair is not asked twice', async () => {
    const live = sha('8');
    const r = reader({ [`${sha('4')}@${live}`]: true });
    await liveBuildHolds('p-kept', { commits: [sha('4')] }, deps(live, [], r.source));
    await liveBuildHolds('p-kept', { commits: [sha('4')] }, deps(live, [], r.source));
    expect(r.asked).toEqual([`${sha('4')}@${live}`]);
  });
});
