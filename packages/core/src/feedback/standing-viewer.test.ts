import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { feedbackStandingOf as feedbackStandingOf_, type StandingViewer } from './standing.js';

/** When the times read: a master serves, so no wait here reads stuck by the master alone. */
const AT = {
  since: new Date('2026-10-01T00:00:00Z'),
  master: 'serves' as const,
  now: new Date('2026-10-02T00:00:00Z'),
};
const NO_STANDING_FACTS = { masterOwesTriage: false, carrierRelease: null };

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
        masterOwesTriage: true,
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
    expect(s.attentionGroup).toBe('moving');
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
        masterOwesTriage: false,
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
    expect(planned('automatic').attentionGroup).toBe('moving');
  });
});

// ISS-1072 round 3: Feedback listed items Resolved under Moving where the confirm they wait on is an
// agent's (a channel agent reporter, or the master verifying): a resolved item is shipped and waits
// on its confirm, someone else's turn, never Moving.
describe('a resolved item is never Moving', () => {
  it.each<[string, Record<string, boolean>, 'issue' | 'answer']>([
    ['an agent reporter confirms it', { reporterIsAgent: true }, 'issue'],
    ['the master verifies it', { masterVerifies: true }, 'issue'],
    ['the master confirms an answer', { masterVerifies: true }, 'answer'],
  ])('waits, not moves, where %s', (_, facts, route) => {
    const s = feedbackStandingOf(
      'resolved',
      route,
      [],
      'Channel agent',
      viewer(),
      null,
      { ...NO_STANDING_FACTS, ...facts },
      AT,
    );
    expect(s.waitingOn.kind).toBe('agent');
    expect(s.attentionGroup).not.toBe('moving');
    expect(s.attentionGroup).toBe('waiting');
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
      { ...NO_STANDING_FACTS, masterOwesTriage: true },
      fresh,
    );
    expect(s.waitingOn.kind).toBe('agent');
    expect(s.attentionGroup).toBe('moving');
  });
});
