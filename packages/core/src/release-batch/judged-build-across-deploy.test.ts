// @direct-test-of packages/core/src/release-batch/judged-build.ts
// ISS-1182 (FB-592): on forge-dev every push deploys, and the commit production serves after a deploy
// is one no pair the served-ancestry pass asked names yet. Every verdict commit no release record
// placed fell to `unanswered`, so right after dev.619 deployed REQ-12 read 8/23, then 13/23 and 16/23,
// and was back at 21/23 four minutes later. A commit the previous live build held keeps that answer,
// marked as re-checked, until the host is asked whether the new build descends from the previous one;
// once it answers, the new build's holdings are derived from the previous build's, one pair a deploy.

import { describe, expect, it } from 'vitest';
import { type Carriage, carriageKey } from '../issues/index.js';
import { type JudgedBuildDeps, liveBuildHolds } from './judged-build.js';

const sha = (c: string) => c.repeat(40);
const PREVIOUS = sha('a');
const LIVE = sha('b');
/** Judged at a commit the previous live build held, by a kept answer. */
const OLDER = sha('c');
/** Judged at a commit the previous live build did not hold. */
const OTHER = sha('d');

/** Production serves `LIVE`; `kept` are the source host's kept answers, and production was read
 *  serving `PREVIOUS` before (`liveSince` the first reading of `LIVE`, null where none was taken). */
function deps(
  kept: Record<string, Carriage>,
  liveSince: Date | null = null,
): JudgedBuildDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    served: async () => ({ ok: true, value: LIVE }),
    releases: async () => [],
    ancestry: async () => ({ kind: 'none', why: 'no source host and no box' }),
    withdrawn: async () => false,
    heldAncestry: async (_projectId, judged, served) => {
      const out = new Map<string, Carriage>();
      for (const j of judged)
        for (const s of served) {
          asked.push(`${j}@${s}`);
          const answer = kept[carriageKey(j, s)];
          if (answer) out.set(carriageKey(j, s), answer);
        }
      return out;
    },
    servedBefore: async (_projectId, live, commits) =>
      new Map(
        commits.map((c) => {
          const bridge = kept[carriageKey(PREVIOUS, live)];
          return [
            c,
            {
              liveSince,
              before: [
                {
                  commit: PREVIOUS,
                  descends: bridge ? bridge.kind === 'descends' : null,
                  holds: kept[carriageKey(c, PREVIOUS)]?.kind === 'descends',
                },
              ],
            },
          ];
        }),
      ),
  };
}

const descends: Carriage = { kind: 'descends', by: 'the source host answered so' };
const differs: Carriage = { kind: 'differs', paths: ['src/a.ts'] };

describe('what the live build holds right after a deploy (ISS-1182)', () => {
  it('keeps the previous live build’s answer, marked as re-checked, where nothing was asked of the new one', async () => {
    const read = await liveBuildHolds(
      'p-deploy',
      { commits: [PREVIOUS, OLDER, OTHER] },
      deps({
        [carriageKey(OLDER, PREVIOUS)]: descends,
        [carriageKey(OTHER, PREVIOUS)]: differs,
      }),
    );
    expect(read?.sha).toBe(LIVE);
    // neither the previous live build itself nor what it held reads as unanswered
    expect(read?.unanswered.has(PREVIOUS)).toBe(false);
    expect(read?.unanswered.has(OLDER)).toBe(false);
    expect(read?.holds.get(PREVIOUS)).toBe(true);
    expect(read?.holds.get(OLDER)).toBe(true);
    expect(read?.rechecking?.get(PREVIOUS)).toContain(PREVIOUS);
    expect(read?.rechecking?.get(OLDER)).toContain(PREVIOUS);
    // what the previous build did not hold has no answer to keep
    expect(read?.holds.has(OTHER)).toBe(false);
    expect(read?.unanswered.has(OTHER)).toBe(true);
  });

  it('derives the new build’s holdings from the previous build’s once the host says it descends from it', async () => {
    const read = await liveBuildHolds(
      'p-bridged',
      { commits: [PREVIOUS, OLDER] },
      deps({
        [carriageKey(OLDER, PREVIOUS)]: descends,
        [carriageKey(PREVIOUS, LIVE)]: descends,
      }),
    );
    expect(read?.holds.get(PREVIOUS)).toBe(true);
    expect(read?.holds.get(OLDER)).toBe(true);
    expect(read?.rechecking?.size ?? 0).toBe(0);
    expect(read?.unanswered.size).toBe(0);
  });

  it('reads a commit the host says the new build does not hold as not held, whatever the previous one held', async () => {
    const read = await liveBuildHolds(
      'p-differs',
      { commits: [OLDER] },
      deps({
        [carriageKey(OLDER, PREVIOUS)]: descends,
        [carriageKey(OLDER, LIVE)]: differs,
      }),
    );
    expect(read?.holds.get(OLDER)).toBe(false);
    expect(read?.rechecking?.has(OLDER) ?? false).toBe(false);
  });

  it('keeps no answer where the new build does not descend from the previous one', async () => {
    const read = await liveBuildHolds(
      'p-rolled-back',
      { commits: [OLDER] },
      deps({
        [carriageKey(OLDER, PREVIOUS)]: descends,
        [carriageKey(PREVIOUS, LIVE)]: differs,
      }),
    );
    expect(read?.holds.has(OLDER)).toBe(false);
    expect(read?.unanswered.has(OLDER)).toBe(true);
  });

  it('keeps no answer once the new build has been served long enough for the pass to have asked', async () => {
    const read = await liveBuildHolds(
      'p-stale',
      { commits: [OLDER] },
      deps({ [carriageKey(OLDER, PREVIOUS)]: descends }, new Date(Date.now() - 60 * 60_000)),
    );
    expect(read?.holds.has(OLDER)).toBe(false);
    expect(read?.unanswered.get(OLDER)).toContain('re-checked');
  });

  // ISS-1182 round 2: at 16:35:17Z on forge-dev REQ-12 read 12/23 with nothing re-checked while a
  // rolling deploy replaced 9e7f8c7750, the probe answering nothing whole for a moment
  it('keeps what the build last read held, re-checked, where production cannot be read just now', async () => {
    const d = deps({ [carriageKey(OLDER, LIVE)]: descends });
    expect((await liveBuildHolds('p-rolling', { commits: [OLDER] }, d))?.holds.get(OLDER)).toBe(
      true,
    );
    d.served = async () => ({ ok: false, why: '502 Bad Gateway' });
    const read = await liveBuildHolds('p-rolling', { commits: [OLDER, OTHER] }, d);
    expect(read?.sha).toBe(LIVE);
    expect(read?.holds.get(OLDER)).toBe(true);
    expect(read?.rechecking?.get(OLDER)).toContain('502 Bad Gateway');
    expect(read?.unanswered.has(OLDER)).toBe(false);
    // a reader that never read production keeps nothing
    const cold = deps({});
    cold.served = async () => ({ ok: false, why: '502 Bad Gateway' });
    const never = await liveBuildHolds('p-rolling', { commits: [OLDER] }, cold);
    expect(never?.sha).toBeNull();
    expect(never?.unanswered.get(OLDER)).toContain('502 Bad Gateway');
  });

  it('weighs a new live build no pass kept yet against the builds kept before it', async () => {
    const read = await liveBuildHolds(
      'p-new-sha',
      { commits: [OLDER] },
      deps({ [carriageKey(OLDER, PREVIOUS)]: descends }, null),
    );
    expect(read?.holds.get(OLDER)).toBe(true);
    expect(read?.rechecking?.get(OLDER)).toContain(PREVIOUS);
  });
});
