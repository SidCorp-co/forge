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
