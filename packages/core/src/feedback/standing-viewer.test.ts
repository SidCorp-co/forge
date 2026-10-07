import { describe, expect, it } from 'vitest';
import { feedbackStandingOf, type StandingViewer } from './standing.js';

const viewer = (over: Partial<StandingViewer> = {}): StandingViewer => ({
  isReporter: false,
  canTriage: false,
  canApproveRelease: false,
  canWrite: false,
  canAdmin: false,
  ...over,
});

describe('an untriaged item waits on whoever can triage it, read for this viewer', () => {
  it('names a holder of feedback.approve, not You, for a viewer who cannot triage', () => {
    const s = feedbackStandingOf('new', null, [], 'Reporter', viewer(), null);
    expect(s.waitingOn.kind).toBe('person');
    expect(s.waitingOn.who).toBe('A holder of feedback.approve');
    expect(s.attentionGroup).toBe('waiting');
  });

  it('is the viewer’s own turn when the viewer holds feedback.approve', () => {
    const s = feedbackStandingOf(
      'reopened',
      null,
      [],
      'Reporter',
      viewer({ canTriage: true }),
      null,
    );
    expect(s.waitingOn).toMatchObject({ kind: 'you', who: 'You', act: 'triage it' });
    expect(s.attentionGroup).toBe('needs_you');
  });

  it('names the project master for an item it owes a triage, whoever reads it', () => {
    const s = feedbackStandingOf('new', null, [], 'Reporter', viewer({ canTriage: true }), null, {
      masterOwesTriage: true,
      carrierRelease: null,
    });
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
    feedbackStandingOf('planned', 'issue', ['ISS-9'], 'Reporter', v, null, {
      masterOwesTriage: false,
      carrierRelease: release,
      releaseHolders,
    });

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
      'cut the release that carries ISS-9: no person on this project holds project.admin until it is granted under Settings → Members',
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
