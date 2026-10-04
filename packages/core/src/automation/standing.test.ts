import type { AgentReportView } from '@forge/contracts/agent-reports';
import { describe, expect, it } from 'vitest';
import {
  type AutomationViewer,
  type FireFacts,
  fireStandingOf,
  producedOf,
  proposalsOf,
  type ReportFacts,
  reportOrder,
  reportStandingOf,
  type ScheduleFacts,
  scheduleStandingOf,
  scheduleStateOf,
  triageWaitOf,
} from './standing.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const OWNER = { id: 'u-owner', name: 'Minh' };

const owner: AutomationViewer = { userId: OWNER.id, canWrite: true, isAdmin: false };
const member: AutomationViewer = { userId: 'u-member', canWrite: true, isAdmin: false };
const admin: AutomationViewer = { userId: 'u-admin', canWrite: true, isAdmin: true };
const onlooker: AutomationViewer = { userId: 'u-viewer', canWrite: false, isAdmin: false };

function schedule(over: Partial<ScheduleFacts> = {}): ScheduleFacts {
  return {
    id: 's-1',
    projectId: 'p-1',
    name: 'nightly-triage',
    kind: 'prompt',
    cron: '0 2 * * *',
    enabled: true,
    templateKey: null,
    mode: null,
    targetProjectSlug: null,
    nextRunAt: new Date('2026-10-05T02:00:00.000Z'),
    createdAt: ago(10_000),
    owner: OWNER,
    ...over,
  };
}

const streakOf = (streak: number, minutesAgo = 60) => ({
  scheduleId: 's-1',
  streak,
  lastCountedAt: ago(minutesAgo),
  streakStartedAt: streak > 0 ? ago(minutesAgo + 60) : null,
});

function fire(over: Partial<FireFacts> = {}): FireFacts {
  return {
    id: 'f-1',
    scheduleId: 's-1',
    scheduleName: 'nightly-triage',
    status: 'success',
    trigger: 'scheduled',
    startedAt: ago(30),
    finishedAt: ago(20),
    reason: null,
    refusal: null,
    error: null,
    disposition: null,
    sessionId: 'sess-1',
    pipelineRunId: 'run-1',
    reports: 0,
    newReports: 0,
    issues: 0,
    notifications: 0,
    ...over,
  };
}

function report(over: Partial<AgentReportView> = {}): AgentReportView {
  return {
    id: 'r-1',
    projectId: 'p-1',
    projectSlug: 'eco-a',
    issueId: null,
    runId: null,
    jobId: null,
    stage: null,
    kind: 'friction',
    severity: 'medium',
    target: 'tool',
    targetRef: null,
    summary: 'a report',
    detail: null,
    suggestion: null,
    signalKey: 'k',
    sessionId: null,
    scheduleRunId: null,
    triage: 'new',
    triagedBy: null,
    triagedAt: null,
    triageReason: null,
    duplicateOf: null,
    linkedIssueId: null,
    feedback: null,
    createdAt: ago(100).toISOString(),
    ...over,
  };
}

const ctxFor = (viewer: AutomationViewer) => ({ viewer, failStreak: 2, now: NOW });

describe('scheduleStateOf: one state per schedule, from its row, its streak and its newest fire', () => {
  it('off beats every other reading: a paused schedule is never claimed', () => {
    expect(
      scheduleStateOf(schedule({ enabled: false, owner: null }), streakOf(5), null, 2, NOW).state,
    ).toBe('off');
  });

  it('owner_gone when ownerId is null, whatever its fires did', () => {
    expect(scheduleStateOf(schedule({ owner: null }), streakOf(0), null, 2, NOW).state).toBe(
      'owner_gone',
    );
  });

  it('failing at scheduleFailStreak trailing failures, as alert A5 reads it', () => {
    const read = scheduleStateOf(schedule(), streakOf(2), { status: 'failed' }, 2, NOW);
    expect(read.state).toBe('failing');
    expect(read.rule).toContain('clears on the next successful fire');
  });

  it('on below the threshold, and on when the streak is outside the active window', () => {
    expect(scheduleStateOf(schedule(), streakOf(1), { status: 'failed' }, 2, NOW).state).toBe('on');
    expect(scheduleStateOf(schedule(), streakOf(3, 60 * 24 * 9), null, 2, NOW).state).toBe('on');
  });

  it('firing while its newest fire runs, unless it is failing', () => {
    expect(scheduleStateOf(schedule(), streakOf(0), { status: 'running' }, 2, NOW).state).toBe(
      'firing',
    );
    expect(scheduleStateOf(schedule(), streakOf(2), { status: 'running' }, 2, NOW).state).toBe(
      'failing',
    );
  });
});

describe('scheduleStandingOf: whom a schedule waits on, per viewer', () => {
  it('a failing schedule waits on its owner to fix it: needs-you for the owner only', () => {
    const mine = scheduleStandingOf(schedule(), streakOf(2), null, ctxFor(owner));
    expect(mine.waitingOn).toMatchObject({ kind: 'you', act: 'fix_schedule' });
    expect(mine.attentionGroup).toBe('needs_you');
    const theirs = scheduleStandingOf(schedule(), streakOf(2), null, ctxFor(admin));
    expect(theirs.waitingOn).toMatchObject({ kind: 'person', who: 'Minh', act: 'fix_schedule' });
    expect(theirs.attentionGroup).toBe('waiting');
  });

  it('an ownerless schedule waits on the admins to take it over', () => {
    const forAdmin = scheduleStandingOf(schedule({ owner: null }), null, null, ctxFor(admin));
    expect(forAdmin.waitingOn).toMatchObject({ kind: 'you', act: 'reassign_owner' });
    const forMember = scheduleStandingOf(schedule({ owner: null }), null, null, ctxFor(member));
    expect(forMember.waitingOn).toMatchObject({ kind: 'admins', act: 'reassign_owner' });
    expect(forMember.attentionGroup).toBe('waiting');
  });

  it('an off schedule serves no next fire and waits on nobody', () => {
    const off = scheduleStandingOf(schedule({ enabled: false }), null, null, ctxFor(owner));
    expect(off).toMatchObject({ state: 'off', nextFireAt: null, attentionGroup: 'off' });
    expect(off.waitingOn.kind).toBe('none');
  });
});

describe('triageWaitOf: the schedule owner first, otherwise members with write access', () => {
  it('a report a fire filed waits on that schedule owner', () => {
    expect(triageWaitOf({ owner: OWNER }, owner)).toMatchObject({
      kind: 'you',
      act: 'triage_report',
    });
    expect(triageWaitOf({ owner: OWNER }, member)).toMatchObject({ kind: 'person', who: 'Minh' });
  });

  it('with no owner, or no fire, any writer triages it and a read-only member does not', () => {
    expect(triageWaitOf({ owner: null }, member).kind).toBe('you');
    expect(triageWaitOf(null, admin).kind).toBe('you');
    expect(triageWaitOf(null, onlooker)).toMatchObject({
      kind: 'writers',
      who: 'A project writer',
    });
  });
});

describe('Fire.produced counts what was joined to the fire', () => {
  it('one of each reads 1/1/1/1, and a prompt fire’s own run is not something it produced', () => {
    const p = producedOf(fire({ reports: 1, newReports: 1, issues: 1, notifications: 1 }), 1);
    expect(p).toEqual({
      reports: 1,
      newReports: 1,
      proposals: 1,
      issues: 1,
      runs: 0,
      notifications: 1,
    });
  });

  it('a runner-less fire that started a run produced it', () => {
    expect(producedOf(fire({ sessionId: null, pipelineRunId: 'cut-1' }), 0).runs).toBe(1);
  });

  it('a steward feedback or skip is not a proposal', () => {
    const actions = [
      { skill: 'a', kind: 'proposed', summary: '' },
      { skill: 'b', kind: 'applied', summary: '' },
      { skill: 'c', kind: 'feedback', summary: '' },
      { skill: 'd', kind: 'skipped', summary: '' },
    ];
    expect(proposalsOf(actions).map((a) => a.skill)).toEqual(['a', 'b']);
    expect(proposalsOf(null)).toEqual([]);
  });
});

describe('fireStandingOf: the attention groups of the Fires tab', () => {
  const failing = {
    ...scheduleStandingOf(schedule(), streakOf(2), fire({ status: 'failed' }), ctxFor(owner)),
    facts: schedule(),
  };

  it('a fire whose new reports wait on the viewer needs them', () => {
    const f = fireStandingOf(fire({ reports: 2, newReports: 1 }), 0, failing, owner);
    expect(f.attentionGroup).toBe('needs_you');
    expect(f.waitingOn).toMatchObject({ kind: 'you', act: 'triage_report' });
    expect(
      fireStandingOf(fire({ reports: 2, newReports: 1 }), 0, failing, member).attentionGroup,
    ).toBe('produced');
  });

  it('a success groups by whether it produced anything', () => {
    expect(fireStandingOf(fire({ notifications: 1 }), 0, undefined, owner).attentionGroup).toBe(
      'produced',
    );
    expect(fireStandingOf(fire(), 0, undefined, owner).attentionGroup).toBe('nothing_produced');
  });

  it('a failed or skipped fire is failed_or_skipped, a running one running', () => {
    expect(
      fireStandingOf(fire({ status: 'skipped', reason: 'no-device' }), 0, undefined, owner)
        .attentionGroup,
    ).toBe('failed_or_skipped');
    expect(
      fireStandingOf(fire({ status: 'running', finishedAt: null }), 0, undefined, owner)
        .attentionGroup,
    ).toBe('running');
  });

  it('the newest failed fire of a failing schedule carries its fix_schedule wait', () => {
    const schedFire = fire({ status: 'failed' });
    const f = fireStandingOf(schedFire, 0, failing, owner);
    expect(f.waitingOn).toMatchObject({ kind: 'you', act: 'fix_schedule' });
    expect(f.attentionGroup).toBe('needs_you');
    expect(
      fireStandingOf(fire({ id: 'f-old', status: 'failed' }), 0, failing, owner).attentionGroup,
    ).toBe('failed_or_skipped');
  });
});

describe('reportStandingOf: the Reports tab groups and whom each waits on', () => {
  const facts = (over: Partial<ReportFacts> = {}): ReportFacts => ({
    view: report(),
    fire: null,
    issue: null,
    ...over,
  });

  it('a new report from a fire waits on its schedule owner', () => {
    const fromFire = facts({
      view: report({ scheduleRunId: 'f-1' }),
      fire: { id: 'f-1', scheduleId: 's-1', scheduleName: 'nightly-triage', owner: OWNER },
    });
    expect(reportStandingOf(fromFire, owner)).toMatchObject({
      attentionGroup: 'needs_you',
      fire: { id: 'f-1' },
    });
    expect(reportStandingOf(fromFire, admin).attentionGroup).toBe('waiting');
  });

  it('a filed report names where it went; a dismissed one waits on nobody', () => {
    const filed = facts({
      view: report({ triage: 'filed', linkedIssueId: 'i-1' }),
      issue: { key: 'ISS-25', status: 'draft' },
    });
    expect(reportStandingOf(filed, owner)).toMatchObject({
      attentionGroup: 'filed',
      waitingOn: { kind: 'issue', who: 'ISS-25', ref: 'ISS-25' },
    });
    const dismissed = facts({ view: report({ triage: 'dismissed', triageReason: 'no' }) });
    expect(reportStandingOf(dismissed, owner)).toMatchObject({
      attentionGroup: 'closed',
      waitingOn: { kind: 'none' },
    });
  });

  it('orders new reports high severity first, then oldest, before the triaged ones', () => {
    const rows = [
      report({ id: 'triaged', triage: 'dismissed', triagedAt: ago(1).toISOString() }),
      report({ id: 'low-old', severity: 'low', createdAt: ago(500).toISOString() }),
      report({ id: 'high-new', severity: 'high', createdAt: ago(5).toISOString() }),
      report({ id: 'high-old', severity: 'high', createdAt: ago(50).toISOString() }),
    ].map((v) => reportStandingOf(facts({ view: v }), member));
    expect(rows.sort(reportOrder).map((r) => r.id)).toEqual([
      'high-old',
      'high-new',
      'low-old',
      'triaged',
    ]);
  });
});
