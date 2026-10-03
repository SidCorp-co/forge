import { describe, expect, it } from 'vitest';
import {
  deriveStanding,
  STUCK_AFTER_DAYS,
  type StandingInput,
  type StandingIssue,
  type StandingRevision,
  stateOf,
} from './standing.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const LAN = { userId: 'lan', canSignOff: true };
const VIEWER_ONLY = { userId: 'tuan', canSignOff: false };

const rev = (
  revision: number,
  state: StandingRevision['state'],
  extra: Partial<StandingRevision> = {},
): StandingRevision => ({
  revision,
  state,
  authorId: 'minh',
  authorName: 'Minh',
  authorKind: 'human',
  createdAt: daysAgo(2),
  proposedAt: null,
  decidedAt: null,
  ...extra,
});

const issue = (id: string, status: string, extra: Partial<StandingIssue> = {}): StandingIssue => ({
  id,
  displayId: `ISS-${id}`,
  title: `Issue ${id}`,
  status,
  updatedAt: daysAgo(1),
  ...extra,
});

const BC1 = {
  id: 'bc1-r1',
  code: 'BC-1',
  body: 'Remind at D+1',
  sinceRevision: 1,
  retiredRevision: null,
};
const BC2_OLD = {
  id: 'bc2-r1',
  code: 'BC-2',
  body: 'Old wording',
  sinceRevision: 1,
  retiredRevision: 2,
};
const BC2 = {
  id: 'bc2-r2',
  code: 'BC-2',
  body: 'New wording',
  sinceRevision: 2,
  retiredRevision: null,
};
const BC3 = {
  id: 'bc3-r1',
  code: 'BC-3',
  body: 'Weekly report',
  sinceRevision: 1,
  retiredRevision: null,
};

const base = (over: Partial<StandingInput> = {}): StandingInput => ({
  status: 'agreed',
  phase: 'in_delivery',
  owner: { id: 'lan', name: 'Lan' },
  viewer: LAN,
  revisions: [rev(2, 'current', { decidedAt: daysAgo(3) }), rev(1, 'superseded')],
  currentRevision: 2,
  criteria: [BC1, BC2_OLD, BC2, BC3],
  issues: [issue('1', 'in_progress'), issue('2', 'closed')],
  issueCriteria: [],
  openSuggestionKinds: [],
  updatedAt: daysAgo(3),
  now: NOW,
  ...over,
});

describe('stateOf: the lifecycle a person reads', () => {
  it('splits agreed by the derived delivery phase and passes every other status through', () => {
    expect(stateOf('agreed', 'agreed')).toBe('agreed');
    expect(stateOf('agreed', null)).toBe('agreed');
    expect(stateOf('agreed', 'in_delivery')).toBe('in_delivery');
    expect(stateOf('agreed', 'delivered')).toBe('delivered');
    expect(stateOf('draft', 'delivered')).toBe('draft');
    expect(stateOf('accepted', 'delivered')).toBe('accepted');
    expect(stateOf('dropped', null)).toBe('dropped');
  });
});

describe('whose turn it is', () => {
  it('rule 1: accepted or dropped is done and waits on nobody', () => {
    for (const status of ['accepted', 'dropped'] as const) {
      const s = deriveStanding(base({ status, owner: null, updatedAt: daysAgo(90) }));
      expect(s.attentionGroup).toBe('done');
      expect(s.waitingOn.kind).toBe('none');
    }
  });

  it('rule 2: a proposed revision needs a viewer who may sign off, and is someone else’s turn otherwise', () => {
    const revisions = [rev(3, 'proposed', { proposedAt: daysAgo(1) }), rev(2, 'current')];
    const mine = deriveStanding(base({ revisions }));
    expect(mine.attentionGroup).toBe('needs_you');
    expect(mine.waitingOn).toMatchObject({ kind: 'you', who: 'You', act: 'accept r3' });
    expect(mine.facts.proposedRevision).toBe(3);
    const theirs = deriveStanding(base({ revisions, viewer: VIEWER_ONLY }));
    expect(theirs.attentionGroup).toBe('others');
    expect(theirs.waitingOn).toMatchObject({
      kind: 'person',
      who: 'BA or owner',
      act: 'accept r3',
    });
  });

  it('rule 2 holds over every later rule: a proposal outranks a delivered phase and an open breakdown', () => {
    const s = deriveStanding(
      base({
        phase: 'delivered',
        openSuggestionKinds: ['breakdown'],
        revisions: [rev(3, 'proposed'), rev(2, 'current')],
      }),
    );
    expect(s.waitingOn.act).toBe('accept r3');
  });

  it('rule 3: a draft revision waits on its author — you if you wrote it, an agent named as one', () => {
    const draft = [rev(1, 'draft')];
    const minh = deriveStanding(
      base({ status: 'draft', phase: null, currentRevision: null, revisions: draft, issues: [] }),
    );
    expect(minh.attentionGroup).toBe('others');
    expect(minh.waitingOn).toMatchObject({ kind: 'person', who: 'Minh', act: 'finish draft' });
    expect(minh.facts.draftRevision).toBe(1);
    const own = deriveStanding(
      base({
        status: 'draft',
        phase: null,
        currentRevision: null,
        revisions: [rev(1, 'draft', { authorId: 'lan' })],
        issues: [],
      }),
    );
    expect(own.waitingOn).toMatchObject({ kind: 'you', act: 'propose r1' });
    const agent = deriveStanding(
      base({
        status: 'draft',
        phase: null,
        currentRevision: null,
        revisions: [
          rev(1, 'draft', { authorId: 'ba', authorName: 'BA assistant', authorKind: 'agent' }),
        ],
        issues: [],
      }),
    );
    expect(agent.waitingOn).toMatchObject({ kind: 'agent', who: 'BA assistant' });
  });

  it('rule 4: a draft requirement whose head is current waits on a signer to agree that revision', () => {
    const s = deriveStanding(base({ status: 'draft', phase: null, issues: [] }));
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn.act).toBe('agree r2');
  });

  it('rule 5: every linked issue closed waits on a signer to accept the delivery', () => {
    const s = deriveStanding(base({ phase: 'delivered', issues: [issue('2', 'closed')] }));
    expect(s.state).toBe('delivered');
    expect(s.waitingOn).toMatchObject({ kind: 'you', act: 'accept delivery' });
  });

  it('rule 6: an open breakdown suggestion waits on a signer to approve it', () => {
    const s = deriveStanding(
      base({ phase: 'agreed', issues: [], openSuggestionKinds: ['readiness', 'breakdown'] }),
    );
    expect(s.waitingOn.act).toBe('approve breakdown');
    const readinessOnly = deriveStanding(
      base({ phase: 'agreed', issues: [], openSuggestionKinds: ['readiness'] }),
    );
    expect(readinessOnly.waitingOn.act).toBe('break down');
  });

  it('rule 7: agreed with no linked issue is the master’s turn to break it down; a dropped issue does not count', () => {
    const s = deriveStanding(base({ phase: 'agreed', issues: [issue('9', 'dropped')] }));
    expect(s.attentionGroup).toBe('others');
    expect(s.waitingOn).toMatchObject({ kind: 'agent', who: 'Master', act: 'break down' });
    expect(s.facts.issuesTotal).toBe(0);
  });

  it('rule 8: agreed with issues being worked is moving, counted label-first', () => {
    const s = deriveStanding(base());
    expect(s.attentionGroup).toBe('moving');
    expect(s.waitingOn).toMatchObject({ kind: 'issues', act: 'Running 1 of 2' });
    const idle = deriveStanding(base({ issues: [issue('1', 'open'), issue('2', 'closed')] }));
    expect(idle.waitingOn.act).toBe('Done 1 of 2');
  });
});

describe('stuck', () => {
  it('no owner is stuck, naming that someone has to take it', () => {
    const s = deriveStanding(base({ owner: null }));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'none', who: 'No owner', act: 'assign one' });
  });

  it(`untouched for ${STUCK_AFTER_DAYS} days is stuck and keeps whom it waits on; one day less is not`, () => {
    const old = {
      updatedAt: daysAgo(40),
      revisions: [rev(1, 'draft', { createdAt: daysAgo(40) })],
    };
    const at = (d: number) =>
      deriveStanding(
        base({
          status: 'draft',
          phase: null,
          currentRevision: null,
          issues: [],
          updatedAt: daysAgo(d),
          revisions: [rev(1, 'draft', { createdAt: daysAgo(d) })],
        }),
      );
    expect(
      deriveStanding(
        base({ status: 'draft', phase: null, currentRevision: null, issues: [], ...old }),
      ).attentionGroup,
    ).toBe('stuck');
    expect(at(STUCK_AFTER_DAYS).attentionGroup).toBe('stuck');
    expect(at(STUCK_AFTER_DAYS).waitingOn.who).toBe('Minh');
    expect(at(STUCK_AFTER_DAYS - 1).attentionGroup).toBe('others');
  });

  it('work on a linked issue counts as a touch', () => {
    const s = deriveStanding(
      base({
        updatedAt: daysAgo(60),
        revisions: [rev(2, 'current', { createdAt: daysAgo(60) })],
        issues: [issue('1', 'in_progress', { updatedAt: daysAgo(1) })],
      }),
    );
    expect(s.attentionGroup).toBe('moving');
  });

  it('needs you outranks stuck: an ownerless, old proposal still asks the viewer', () => {
    const s = deriveStanding(
      base({
        owner: null,
        updatedAt: daysAgo(90),
        revisions: [rev(3, 'proposed', { createdAt: daysAgo(90) })],
      }),
    );
    expect(s.attentionGroup).toBe('needs_you');
  });
});

describe('coverage by business criterion', () => {
  const link = (
    issueId: string,
    wording: string,
    verdict: 'pass' | 'short' | 'fail' | 'skipped' | null,
    n = 1,
  ) => ({
    issueId,
    n,
    requirementCriterionId: wording,
    verdict,
  });

  it('reads the wordings live at the current revision, in code order', () => {
    const s = deriveStanding(base());
    expect(s.shownRevision).toBe(2);
    expect(s.coverage.map((c) => [c.code, c.body])).toEqual([
      ['BC-1', 'Remind at D+1'],
      ['BC-2', 'New wording'],
      ['BC-3', 'Weekly report'],
    ]);
  });

  it('no link is a gap; a pass or short on the live wording is passing; a fail anywhere live is failing', () => {
    const s = deriveStanding(
      base({
        issueCriteria: [
          link('1', 'bc1-r1', 'pass'),
          link('2', 'bc1-r1', 'short', 2),
          link('1', 'bc3-r1', 'pass', 3),
          link('2', 'bc3-r1', 'fail', 4),
        ],
      }),
    );
    expect(s.coverage.map((c) => c.verdict)).toEqual(['passing', 'gap', 'failing']);
    expect(s.facts).toMatchObject({ passing: 1, judged: 2, criteria: 3 });
  });

  it('a link with no verdict yet, or skipped, is not judged', () => {
    for (const v of [null, 'skipped'] as const) {
      const s = deriveStanding(
        base({ issueCriteria: [link('1', 'bc1-r1', 'pass'), link('2', 'bc1-r1', v, 2)] }),
      );
      expect(s.coverage[0]?.verdict).toBe('not_judged');
    }
  });

  it('a link only to an earlier wording is stale, and marked stale on the issue line', () => {
    const s = deriveStanding(base({ issueCriteria: [link('1', 'bc2-r1', 'pass')] }));
    const bc2 = s.coverage.find((c) => c.code === 'BC-2');
    expect(bc2?.verdict).toBe('stale');
    expect(bc2?.issues[0]).toMatchObject({ displayId: 'ISS-1', stale: true, verdict: 'pass' });
  });

  it('a live passing link outranks a stale one on the same code', () => {
    const s = deriveStanding(
      base({ issueCriteria: [link('1', 'bc2-r1', 'fail'), link('2', 'bc2-r2', 'pass', 2)] }),
    );
    expect(s.coverage.find((c) => c.code === 'BC-2')?.verdict).toBe('passing');
  });

  it('a dropped issue proves nothing', () => {
    const s = deriveStanding(
      base({ issues: [issue('1', 'dropped')], issueCriteria: [link('1', 'bc1-r1', 'pass')] }),
    );
    expect(s.coverage[0]?.verdict).toBe('gap');
  });

  it('with no current revision it reads the newest one; with no revision at all there is nothing to cover', () => {
    const s = deriveStanding(
      base({
        status: 'draft',
        phase: null,
        currentRevision: null,
        revisions: [rev(1, 'draft')],
        criteria: [BC1],
      }),
    );
    expect(s.shownRevision).toBe(1);
    expect(s.coverage).toHaveLength(1);
    expect(deriveStanding(base({ currentRevision: null, revisions: [] })).coverage).toEqual([]);
  });
});
