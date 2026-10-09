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
  });

  it('reads nothing where nothing is asked, and holds nothing where production cannot be read', async () => {
    expect(await liveBuildHolds('p-none', { commits: [] }, deps(sha('9'), []))).toBeNull();
    const down = await liveBuildHolds(
      'p-down',
      { commits: [sha('1')] },
      deps({ why: 'no probe' }, []),
    );
    expect(down?.sha).toBeNull();
    expect([...(down?.holds ?? [])]).toEqual([]);
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
