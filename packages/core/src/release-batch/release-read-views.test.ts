import { saidDisagreements } from '@forge/contracts/said';
// A draft whose only blocker is RELEASE_ROSTER_OVERSIZE read `can.cut: false` and told "A project
// admin" to split it, with nothing on the page to split it with (HOP 0.1.0, 2026-10-07: the admin
// posted the ids by hand). The read now offers the admin the act the gate's effect names — the
// oldest RELEASE_ROSTER_LIMIT merged issues, cut as this release — and only where that is the one
// reason the cut is refused.

import { say, verbatim } from '@forge/contracts/said';
import { RELEASE_ROSTER_LIMIT, type ReleaseGateView } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import type { ReleaseFacts } from './release-facts.js';
import { detailOf as detailOf_, type Part, type Shared, summaryOf as summaryOf_ } from './release-read-views.js';

/** Every sentence the producer said agrees with the English beside it (`saidDisagreements`). */
const checked = <T>(v: T): T => {
  expect(saidDisagreements(v)).toEqual([]);
  return v;
};
const detailOf = ((...a: Parameters<typeof detailOf_>) => checked(detailOf_(...a))) as typeof detailOf_;
const summaryOf = ((...a: Parameters<typeof summaryOf_>) => checked(summaryOf_(...a))) as typeof summaryOf_;


const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

function facts(n: number): ReleaseFacts {
  const issues = new Map();
  // ids handed in newest first, so the order the roster arrives in is not the order a split takes
  for (let i = n; i >= 1; i -= 1) {
    issues.set(`i${i}`, {
      id: `i${i}`,
      key: `ISS-${i}`,
      title: `Issue ${i}`,
      status: 'awaiting_release',
      updatedAt: new Date(T0),
      releaseNotes: null,
      requirementId: null,
      criteria: [],
      merged: {
        at: new Date(T0 + i * DAY),
        landing: null,
        artifacts: null,
        commitSha: null,
        readPaths: null,
      },
    });
  }
  return { issues, requirements: new Map(), cutters: new Map() };
}

const gate = (code: string): ReleaseGateView => ({
  code,
  kind: 'blocker',
  title: code,
  sentence: code,
  detail: code,
  issues: [],
  owner: {
    kind: 'person',
    who: 'Ada',
    act: 'split this release into smaller releases',
    says: {
      who: say('standing.who.named', { name: 'Ada' }),
      act: say('standing.act.splitRelease'),
    },
  },
  says: { title: verbatim(code), sentence: verbatim(code) },
});

function part(n: number, gates: ReleaseGateView[], state: Part['state'] = 'draft'): Part {
  return {
    version: '0.1.0',
    runId: null,
    state,
    issueIds: Array.from({ length: n }, (_, k) => `i${n - k}`),
    openedAt: null,
    releasedAt: null,
    attempts: [],
    commit: null,
    approvals: [],
    gates,
    verification: null,
  };
}

const shared = (n: number, isAdmin = true): Shared => ({
  current: null,
  required: false,
  viewer: { userId: 'u1', agency: 'human', isAdmin, mayApprove: isAdmin },
  approvers: [],
  admins: ['Ada'],
  facts: facts(n),
  contentLanguage: 'en',
});

describe('splitting an oversize draft', () => {
  const N = RELEASE_ROSTER_LIMIT + 7;

  it('offers an admin the split when oversize is the only blocker, naming the oldest merged issues', () => {
    const s = summaryOf(part(N, [gate('RELEASE_ROSTER_OVERSIZE')]), shared(N));
    expect(s.can).toMatchObject({ cut: false, split: true });
    expect(s.split?.issueIds).toEqual(
      Array.from({ length: RELEASE_ROSTER_LIMIT }, (_, k) => `i${k + 1}`),
    );
    expect(s.split?.rest).toBe(7);
  });

  it('offers no split beside another blocker, to a non-admin, or once the release is cut', () => {
    const both = summaryOf(
      part(N, [gate('RELEASE_ROSTER_OVERSIZE'), gate('RELEASE_RECORD_MISSING')]),
      shared(N),
    );
    expect(both.can.split).toBe(false);
    expect(both.split).toBeNull();
    expect(summaryOf(part(N, [gate('RELEASE_ROSTER_OVERSIZE')]), shared(N, false)).can.split).toBe(
      false,
    );
    expect(summaryOf(part(N, [], 'shipped'), shared(N)).can.split).toBe(false);
  });

  it('keeps an unblocked draft a plain cut', () => {
    const s = summaryOf(part(3, []), shared(3));
    expect(s.can).toMatchObject({ cut: true, split: false });
    expect(s.split).toBeNull();
  });
});

describe('the commit a shipped release names (FB-105)', () => {
  // dev.113 and dev.114 read "Head: none yet" though each finished at a commit its probes verified:
  // no approval was asked and the deploy attempt recorded none, and only those two were read
  it('reads the commit the release finished at where no approval or attempt names one', () => {
    const shipped = {
      ...part(1, [], 'shipped'),
      runId: 'r1',
      commit: '17126a694866e8c48a277579fce9bce59ce213ca',
    };
    const d = detailOf(shipped, shared(1), null, new Map(), [], null);
    expect(d.head).toBe('17126a694866e8c48a277579fce9bce59ce213ca');
  });

  it('reads none on a draft, which has not been deployed', () => {
    expect(detailOf(part(1, []), shared(1), null, new Map(), [], null).head).toBeNull();
  });
});

// JU-11: dev.120 read "Proof · No criteria recorded" while its Checks held a deploy probe, and
// nothing said in words that only the deploy was verified; hop 0.2.0 listed design reviews
// (a design for the owner to approve) among what users get
describe('what a release says it verified', () => {
  const criterion = (standing: 'pass' | 'fail' | 'unjudged') => ({
    n: 1,
    statement: 'the board keeps its cards',
    standing,
    bc: null,
    identity: null,
    reason: null,
    judgedAt: null,
    judgedBy: null,
  });
  const withCriteria = (standings: ('pass' | 'fail' | 'unjudged')[]): Shared => {
    const s = shared(standings.length);
    standings.forEach((standing, k) => {
      const fact = s.facts.issues.get(`i${k + 1}`);
      if (fact) fact.criteria = [criterion(standing)];
    });
    return s;
  };
  const shippedPart = (n: number, verification: Part['verification']): Part => ({
    ...part(n, [], 'shipped'),
    runId: 'r1',
    verification,
  });

  it('says the deploy check only where no criterion is recorded and the run probed production', () => {
    expect(summaryOf(shippedPart(2, 'probed'), shared(2)).verified).toEqual({
      level: 'deploy_only',
      proven: 0,
      total: 0,
      check: 'probed',
    });
  });

  it('says nothing was verified with no criterion and no recorded check, or an unverified close', () => {
    expect(summaryOf(shippedPart(1, null), shared(1)).verified.level).toBe('none');
    expect(summaryOf(shippedPart(1, 'unverified'), shared(1)).verified.level).toBe('none');
  });

  it('counts proven criteria: every one proven, or some of them', () => {
    expect(
      summaryOf(shippedPart(2, 'probed'), withCriteria(['pass', 'pass'])).verified,
    ).toMatchObject({
      level: 'criteria',
      proven: 2,
      total: 2,
    });
    expect(
      summaryOf(shippedPart(3, 'probed'), withCriteria(['pass', 'fail', 'unjudged'])).verified,
    ).toMatchObject({ level: 'some_criteria', proven: 1, total: 3 });
  });

  it('lists an issue whose landing only touched a design under approved designs, not what users get', () => {
    const s = shared(2);
    for (const id of ['i1', 'i2']) {
      const fact = s.facts.issues.get(id);
      if (fact) fact.releaseNotes = { section: 'Added', userFacing: `note ${id}`, technical: null };
    }
    const landings = new Map([
      [
        'i1',
        {
          kind: 'named' as const,
          artifacts: [
            { surface: 'design' as const, ref: 'referral-flow', change: 'changed' as const },
          ],
          unmappedPaths: [],
          unread: null,
          source: 'mark' as const,
        },
      ],
      [
        'i2',
        {
          kind: 'named' as const,
          artifacts: [
            { surface: 'design' as const, ref: 'referral-flow', change: 'changed' as const },
            { surface: 'ui' as const, ref: '/referrals', change: 'added' as const },
          ],
          unmappedPaths: [],
          unread: null,
          source: 'mark' as const,
        },
      ],
    ]);
    const d = detailOf(shippedPart(2, 'probed'), s, null, landings, [], null);
    expect(d.notes.designs.map((e) => e.key)).toEqual(['ISS-1']);
    expect(d.notes.sections.flatMap((x) => x.entries.map((e) => e.key))).toEqual(['ISS-2']);
  });
});
