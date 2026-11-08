import { saidDisagreements, say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import { describe, expect, it } from 'vitest';
import { feedbackStandingOf as feedbackStandingOf_, type StandingViewer } from './standing.js';

/** When the times read: a master serves, so no wait here reads stuck by the master alone. */
const AT = {
  since: new Date('2026-10-01T00:00:00Z'),
  master: 'serves' as const,
  now: new Date('2026-10-02T00:00:00Z'),
};
const NO_STANDING_FACTS = { masterTriages: false, carrierRelease: null };

/** Every sentence the producer said agrees with the English beside it (`saidDisagreements`). */
const checked = <T>(v: T): T => {
  expect(saidDisagreements(v)).toEqual([]);
  return v;
};
const feedbackStandingOf = ((...a: Parameters<typeof feedbackStandingOf_>) =>
  checked(feedbackStandingOf_(...a))) as typeof feedbackStandingOf_;

const viewer = (over: Partial<StandingViewer> = {}): StandingViewer => ({
  isReporter: false,
  canTriage: false,
  canRoute: false,
  routeAsks: 'feedback.approve' as const,
  canApproveRelease: false,
  canWrite: false,
  canAdmin: false,
  ...over,
});

describe('an untriaged item waits on whoever can triage it, read for this viewer', () => {
  it('names a holder of feedback.approve, not You, for a viewer who cannot triage', () => {
    const s = feedbackStandingOf(
      'new',
      null,
      [],
      'Reporter',
      viewer(),
      null,
      NO_STANDING_FACTS,
      AT,
    );
    expect(s.waitingOn.kind).toBe('person');
    expect(s.waitingOn.who).toBe('Feedback triager');
    expect(s.attentionGroup).toBe('waiting');
  });

  it('is the viewer’s own turn when the viewer holds feedback.approve', () => {
    const s = feedbackStandingOf(
      'reopened',
      null,
      [],
      'Reporter',
      viewer({ canTriage: true, canRoute: true }),
      null,
      NO_STANDING_FACTS,
      AT,
    );
    expect(s.waitingOn).toMatchObject({ kind: 'you', who: 'You', act: 'triage it' });
    // the list and Needs you agree: a triage the viewer owes is on their Needs you (ISS-924)
    expect(s.attentionGroup).toBe('needs_you');
  });

  // ISS-639: with approvals.triage off a project writer routes, so the item waits on one and a writer owns it
  it('names a writer, and is a writer’s own turn, where the project turned approvals.triage off', () => {
    const off = { routeAsks: 'project.write' as const };
    const other = feedbackStandingOf(
      'new',
      null,
      [],
      'Reporter',
      viewer(off),
      null,
      NO_STANDING_FACTS,
      AT,
    );
    expect(other.waitingOn).toMatchObject({ kind: 'person', who: 'Member', act: 'triage it' });
    const writer = viewer({ ...off, canWrite: true, canRoute: true });
    const mine = feedbackStandingOf(
      'new',
      null,
      [],
      'Reporter',
      writer,
      null,
      NO_STANDING_FACTS,
      AT,
    );
    expect(mine.waitingOn).toMatchObject({ kind: 'you', who: 'You', act: 'triage it' });
  });

  it('names the project master for an item it owes a triage, whoever reads it', () => {
    const s = feedbackStandingOf(
      'new',
      null,
      [],
      'Reporter',
      viewer({ canTriage: true, canRoute: true }),
      null,
      {
        masterTriages: true,
        carrierRelease: null,
      },
      AT,
    );
    expect(s.waitingOn).toMatchObject({
      kind: 'agent',
      who: "The project's master",
      act: 'triage it',
    });
    expect(s.waitingOn.rule).toContain('feedback.approve');
    expect(s.attentionGroup).toBe('waiting');
  });
});

// ISS-1132: FB-577 sat seven hours at "You: triage it" on forge, a yolo project, because the triage
// wait asked who held feedback.approve and whether a master was live, never the project's policy
describe('a new item is placed by the one rule, read with the project policy', () => {
  const triager = viewer({ canTriage: true, canRoute: true });

  it.each(['new', 'reopened'] as const)(
    'reads %s as the master’s on a project whose policy gives it triage, never a holder’s Needs you',
    (phase) => {
      const s = feedbackStandingOf(
        phase,
        null,
        [],
        'Reporter',
        triager,
        null,
        { ...NO_STANDING_FACTS, masterTriages: true },
        AT,
      );
      expect(s.waitingOn).toMatchObject({
        kind: 'agent',
        who: "The project's master",
        act: 'triage it',
      });
      expect(s.attentionGroup).toBe('waiting');
    },
  );

  // FB-434's shape: a wait on a master nothing can place sat stuck nobody_serves for hours. With no
  // runner bound no master ever comes, so the triage falls to a holder, named, with why
  it('falls to a holder of feedback.approve where no runner is bound to place a master', () => {
    const s = feedbackStandingOf(
      'new',
      null,
      [],
      'Reporter',
      triager,
      null,
      { ...NO_STANDING_FACTS, masterTriages: true, runnerBound: false },
      { ...AT, master: 'none' },
    );
    expect(s.waitingOn).toMatchObject({ kind: 'you', who: 'You', act: 'triage it' });
    expect(s.waitingOn.rule).toContain('no runner is bound');
    expect(s.attentionGroup).toBe('needs_you');
    const other = feedbackStandingOf(
      'new',
      null,
      [],
      'Reporter',
      viewer(),
      null,
      { ...NO_STANDING_FACTS, masterTriages: true, runnerBound: false },
      { ...AT, master: 'none' },
    );
    expect(other.waitingOn).toMatchObject({ kind: 'person', who: 'Feedback triager' });
  });

  it('reads stuck nobody_serves, never a person’s turn, where a runner is bound and no master serves yet', () => {
    const s = feedbackStandingOf(
      'new',
      null,
      [],
      'Reporter',
      triager,
      null,
      { ...NO_STANDING_FACTS, masterTriages: true, runnerBound: true },
      { ...AT, master: 'none' },
    );
    expect(s.waitingOn).toMatchObject({ kind: 'agent', who: "The project's master" });
    expect(s.attentionGroup).toBe('overdue');
    expect(s.times.stuck).toMatchObject({ code: 'nobody_serves' });
  });

  it('still names a holder of feedback.approve where the policy keeps triage a person’s', () => {
    const s = feedbackStandingOf(
      'new',
      null,
      [],
      'Reporter',
      triager,
      null,
      { ...NO_STANDING_FACTS, masterTriages: false },
      AT,
    );
    expect(s.waitingOn).toMatchObject({ kind: 'you', who: 'You', act: 'triage it' });
    expect(s.attentionGroup).toBe('needs_you');
  });
});

describe('an item planned on an issue at the release gate names who releases it', () => {
  const planned = (
    release: 'none' | 'approval' | 'manual' | 'automatic',
    v = viewer(),
    releaseHolders: readonly string[] = ['Ana', 'Bo'],
  ) =>
    feedbackStandingOf(
      'planned',
      'issue',
      ['ISS-9'],
      'Reporter',
      v,
      null,
      {
        masterTriages: false,
        carrierRelease: release,
        releaseHolders,
      },
      AT,
    );

  it('names the writers who release it where the project declares no release model', () => {
    const s = planned('none');
    expect(s.waitingOn).toMatchObject({ kind: 'person', who: 'Ana, Bo' });
    expect(s.waitingOn.act).toContain('ISS-9');
    expect(s.waitingOn.rule).toContain('no release model');
    expect(planned('none', viewer({ canWrite: true })).waitingOn.who).toBe('You');
  });

  it('names the release approvers where the project requires a release approval', () => {
    expect(planned('approval').waitingOn).toMatchObject({
      kind: 'person',
      who: 'Ana, Bo',
      act: 'Approve the release that carries it',
    });
    expect(planned('approval', viewer({ canApproveRelease: true })).waitingOn.who).toBe('You');
  });

  it('names the admins cutting the release where production does not deploy on land, theirs alone', () => {
    expect(planned('manual').waitingOn).toMatchObject({
      kind: 'person',
      who: 'Ana, Bo',
      act: 'cut the release that carries ISS-9',
    });
    expect(planned('manual', viewer({ canWrite: true })).waitingOn.who).toBe('Ana, Bo');
    expect(planned('manual', viewer({ canAdmin: true })).waitingOn.who).toBe('You');
  });

  it('says nobody holds the permission, and where it is granted, when nobody does', () => {
    const s = planned('manual', viewer(), []);
    expect(s.waitingOn).toMatchObject({ kind: 'none', who: 'Nobody' });
    expect(s.waitingOn.act).toBe(
      'cut the release that carries ISS-9: nobody holds project.admin; grant it under Settings → Members',
    );
  });

  it('still waits on the issue where the automatic release carries it', () => {
    expect(planned('automatic').waitingOn).toMatchObject({
      kind: 'issue',
      who: 'ISS-9',
      act: 'ship',
    });
    expect(planned('automatic').attentionGroup).toBe('waiting');
  });
});

// ISS-1072 round 3 and owner 2026-11-08 (D5): a resolved item has shipped. Under strict it waits on
// its confirm, someone else's turn, never Running; outside strict the ship IS its verify, so it is
// Done, nothing waits on its reporter or the master, and its chip says Done (FB-583).
describe('a resolved item is never Running', () => {
  it('waits on its agent reporter under strict', () => {
    const s = feedbackStandingOf(
      'resolved',
      'issue',
      [],
      'Channel agent',
      viewer(),
      null,
      { ...NO_STANDING_FACTS, reporterIsAgent: true },
      AT,
    );
    expect(s.waitingOn.kind).toBe('agent');
    expect(s.attentionGroup).toBe('waiting');
    expect(s.chip).toBe('done');
  });

  it.each<[string, 'issue' | 'answer']>([
    ['its fix shipped', 'issue'],
    ['it was answered', 'answer'],
  ])('is done outside strict where %s, owed by nobody', (_, route) => {
    const s = feedbackStandingOf(
      'resolved',
      route,
      [],
      'Channel agent',
      viewer(),
      null,
      { ...NO_STANDING_FACTS, masterVerifies: true, reporterIsAgent: true, relayOwed: true },
      AT,
    );
    expect(s.attentionGroup).toBe('done');
    expect(s.waitingOn).toMatchObject({
      kind: 'none',
      says: { rule: { key: 'feedback.rule.shippedSettles' } },
    });
    expect(s.times.stuck).toBeNull();
    expect(s.times.dueAt).toBeNull();
    expect(s.chip).toBe('done');
  });

  it('still moves while an agent works it before it ships: the master triaging a new item', () => {
    const fresh = { ...AT, now: new Date('2026-10-01T00:05:00Z') };
    const s = feedbackStandingOf(
      'new',
      null,
      [],
      'Reporter',
      viewer(),
      null,
      { ...NO_STANDING_FACTS, masterTriages: true },
      fresh,
    );
    expect(s.waitingOn.kind).toBe('agent');
    expect(s.attentionGroup).toBe('waiting');
    expect(s.chip).toBe('new');
  });

  it('reads Running with its chip while a carrier issue is in progress', () => {
    const s = feedbackStandingOf(
      'planned',
      'issue',
      ['ISS-9'],
      'Reporter',
      viewer(),
      null,
      {
        ...NO_STANDING_FACTS,
        carrierRunning: true,
        carrier: {
          key: 'ISS-9',
          waitingOn: waitingOn('run', {
            who: say('issues.standing.who.run'),
            act: say('standing.act.none'),
            rule: say('standing.act.none'),
          }),
          since: AT.now,
          stuck: null,
        },
      },
      AT,
    );
    expect(s.attentionGroup).toBe('running');
    expect(s.chip).toBe('running');
  });
});
