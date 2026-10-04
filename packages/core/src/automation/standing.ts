// cm:why where a schedule, a fire and an agent report stand and whom each waits on, derived from what
// `automation/facts.ts` read and nothing else (design automation rev 1, steps streak, settle,
// needs_you and wait_triage; ISS-114): pure, so every rule is a unit test, and no screen derives one

import type { AgentReportView } from '@forge/contracts/agent-reports';
import {
  AUTOMATION_ACT_LABELS,
  type AutomationAct,
  type AutomationPerson,
  type AutomationWaitingKind,
  type FireGroup,
  type FireProduced,
  type FireProposal,
  type FireStanding,
  type ReportFireRef,
  type ReportGroup,
  type ReportStanding,
  type ScheduleGroup,
  type ScheduleLastFire,
  type ScheduleStanding,
  type ScheduleState,
} from '@forge/contracts/automation-standing';
import { nobodyWaits, type WaitingOn } from '@forge/contracts/standing';
import { type LastFire, type ScheduleStreak, streakFails } from './ports.js';

export interface AutomationViewer {
  userId: string;
  /** member or above: may triage a report. */
  canWrite: boolean;
  /** admin or above: may take over a schedule whose owner is gone. */
  isAdmin: boolean;
}

export interface ScheduleFacts {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  cron: string;
  enabled: boolean;
  templateKey: string | null;
  mode: string | null;
  targetProjectSlug: string | null;
  nextRunAt: Date | null;
  createdAt: Date;
  owner: AutomationPerson | null;
}

export type LastFireFacts = LastFire;

export interface FireFacts extends LastFireFacts {
  scheduleId: string;
  scheduleName: string;
  error: string | null;
  disposition: string | null;
  pipelineRunId: string | null;
  reports: number;
  newReports: number;
  issues: number;
  notifications: number;
}

export interface StewardAction {
  skill: string;
  kind: string;
  summary: string;
}

export interface ReportFacts {
  view: AgentReportView;
  fire: (ReportFireRef & { owner: AutomationPerson | null }) | null;
  /** The key and status of the issue a filed report went to, when it went to one. */
  issue: { key: string; status: string } | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

type AutomationWaitingOn = WaitingOn<AutomationWaitingKind>;

const NOBODY = nobodyWaits;

const owed = (
  kind: AutomationWaitingKind,
  who: string,
  act: AutomationAct,
  rule: string,
): AutomationWaitingOn => ({
  kind,
  who,
  act: AUTOMATION_ACT_LABELS[act],
  rule,
  ref: null,
  dueAt: null,
});

function personWait(
  person: AutomationPerson,
  viewer: AutomationViewer,
  act: AutomationAct,
  rule: string,
): AutomationWaitingOn {
  if (person.id === viewer.userId) return owed('you', 'You', act, rule);
  return owed('person', person.name ?? 'The schedule owner', act, rule);
}

function groupWait(
  kind: 'admins' | 'writers',
  viewer: AutomationViewer,
  act: AutomationAct,
  rule: string,
): AutomationWaitingOn {
  const mine = kind === 'admins' ? viewer.isAdmin : viewer.canWrite;
  if (mine) return owed('you', 'You', act, rule);
  return owed(kind, kind === 'admins' ? 'A project admin' : 'A project writer', act, rule);
}

export function scheduleStateOf(
  s: Pick<ScheduleFacts, 'enabled' | 'owner'>,
  streak: Pick<ScheduleStreak, 'streak' | 'lastCountedAt'> | null,
  lastFire: Pick<LastFireFacts, 'status'> | null,
  failStreak: number,
  now: Date,
): { state: ScheduleState; rule: string } {
  if (!s.enabled) return { state: 'off', rule: 'paused: an off schedule is never claimed' };
  if (!s.owner) {
    return {
      state: 'owner_gone',
      rule: 'ownerId is null: the account it ran as is gone, so a prompt fire is refused SCHEDULE_OWNER_GONE until an admin saves it and takes it over',
    };
  }
  if (streak && streakFails(streak, s, failStreak, now)) {
    return {
      state: 'failing',
      rule: `its last ${streak.streak} fires failed, at or above scheduleFailStreak ${failStreak} (a no-device skip counts, already-applied does not); it clears on the next successful fire, not on an edit`,
    };
  }
  if (lastFire?.status === 'running')
    return { state: 'firing', rule: 'its newest fire is running' };
  return {
    state: 'on',
    rule:
      streak && streak.streak > 0
        ? `${streak.streak} failed in a row, under scheduleFailStreak ${failStreak} or outside the active window`
        : 'enabled, and its newest fire did not fail',
  };
}

function scheduleWaitOf(
  state: ScheduleState,
  s: ScheduleFacts,
  viewer: AutomationViewer,
): AutomationWaitingOn {
  if (state === 'failing' && s.owner) {
    return personWait(
      s.owner,
      viewer,
      'fix_schedule',
      'failing: its owner fixes it, pauses it or takes it over',
    );
  }
  if (state === 'owner_gone') {
    return groupWait(
      'admins',
      viewer,
      'reassign_owner',
      'owner gone: an admin saves it to take it over, and runs it as themselves from then on',
    );
  }
  if (state === 'off') return NOBODY('off: nothing fires until it is turned on');
  return NOBODY(s.nextRunAt ? `next fire at ${s.nextRunAt.toISOString()}` : 'no next fire set');
}

function scheduleGroupOf(state: ScheduleState, wait: AutomationWaitingOn): ScheduleGroup {
  if (wait.kind === 'you') return 'needs_you';
  if (state === 'failing' || state === 'owner_gone') return 'waiting';
  return state === 'off' ? 'off' : 'on';
}

function lastFireOf(f: LastFireFacts | null): ScheduleLastFire | null {
  if (!f) return null;
  return {
    id: f.id,
    status: f.status,
    trigger: f.trigger,
    startedAt: f.startedAt.toISOString(),
    finishedAt: iso(f.finishedAt),
    reason: f.reason,
    refusal: f.refusal,
    sessionId: f.sessionId,
  };
}

export function scheduleStandingOf(
  s: ScheduleFacts,
  streak: ScheduleStreak | null,
  lastFire: LastFireFacts | null,
  ctx: { viewer: AutomationViewer; failStreak: number; now: Date },
): ScheduleStanding {
  const { state, rule } = scheduleStateOf(s, streak, lastFire, ctx.failStreak, ctx.now);
  const waitingOn = scheduleWaitOf(state, s, ctx.viewer);
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    kind: s.kind,
    cron: s.cron,
    enabled: s.enabled,
    templateKey: s.templateKey,
    mode: s.mode,
    targetProjectSlug: s.targetProjectSlug,
    state,
    rule,
    nextFireAt: s.enabled ? iso(s.nextRunAt) : null,
    owner: s.owner,
    streak: streak?.streak ?? 0,
    lastFire: lastFireOf(lastFire),
    attentionGroup: scheduleGroupOf(state, waitingOn),
    waitingOn,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Who triages a report: its fire's schedule owner first, otherwise any member with write access. */
export function triageWaitOf(
  fire: { owner: AutomationPerson | null } | null,
  viewer: AutomationViewer,
): AutomationWaitingOn {
  if (fire?.owner) {
    return personWait(
      fire.owner,
      viewer,
      'triage_report',
      'a report a fire filed goes to its schedule owner first',
    );
  }
  return groupWait(
    'writers',
    viewer,
    'triage_report',
    fire
      ? 'its schedule has no owner, so any member with write access triages it'
      : 'no fire filed it, so any member with write access triages it',
  );
}

/** The steward actions a fire's session proposed or applied; feedback and skipped are not proposals. */
export function proposalsOf(actions: readonly StewardAction[] | null): StewardAction[] {
  return (actions ?? []).filter((a) => a.kind === 'proposed' || a.kind === 'applied');
}

export function fireProposals(
  f: Pick<
    FireFacts,
    'id' | 'scheduleId' | 'scheduleName' | 'sessionId' | 'finishedAt' | 'startedAt'
  >,
  actions: readonly StewardAction[] | null,
): FireProposal[] {
  const sessionId = f.sessionId;
  if (!sessionId) return [];
  const at = (f.finishedAt ?? f.startedAt).toISOString();
  return proposalsOf(actions).map((a) => ({
    fireId: f.id,
    scheduleId: f.scheduleId,
    scheduleName: f.scheduleName,
    sessionId,
    skill: a.skill,
    kind: a.kind as FireProposal['kind'],
    summary: a.summary,
    at,
  }));
}

export function producedOf(f: FireFacts, proposals: number): FireProduced {
  return {
    reports: f.reports,
    newReports: f.newReports,
    proposals,
    issues: f.issues,
    runs: f.sessionId === null && f.pipelineRunId !== null ? 1 : 0,
    notifications: f.notifications,
  };
}

const producedTotal = (p: FireProduced) =>
  p.reports + p.proposals + p.issues + p.runs + p.notifications;

function fireWaitOf(
  f: FireFacts,
  schedule: (ScheduleStanding & { facts: ScheduleFacts }) | undefined,
  viewer: AutomationViewer,
): AutomationWaitingOn {
  if (f.newReports > 0) {
    const wait = triageWaitOf(schedule ? { owner: schedule.facts.owner } : null, viewer);
    return { ...wait, rule: `${f.newReports} of its reports wait for triage: ${wait.rule}` };
  }
  const newest = schedule?.lastFire?.id === f.id;
  if (
    newest &&
    schedule &&
    f.status !== 'success' &&
    (schedule.state === 'failing' || schedule.state === 'owner_gone')
  ) {
    return schedule.waitingOn;
  }
  return NOBODY(f.status === 'running' ? 'running' : 'nothing about this fire waits on a person');
}

function fireGroupOf(f: FireFacts, produced: FireProduced, wait: AutomationWaitingOn): FireGroup {
  if (wait.kind === 'you') return 'needs_you';
  if (f.status === 'running') return 'running';
  if (f.status === 'success') return producedTotal(produced) > 0 ? 'produced' : 'nothing_produced';
  return 'failed_or_skipped';
}

export function fireStandingOf(
  f: FireFacts,
  proposals: number,
  schedule: (ScheduleStanding & { facts: ScheduleFacts }) | undefined,
  viewer: AutomationViewer,
): FireStanding {
  const produced = producedOf(f, proposals);
  const waitingOn = fireWaitOf(f, schedule, viewer);
  return {
    id: f.id,
    scheduleId: f.scheduleId,
    scheduleName: f.scheduleName,
    trigger: f.trigger,
    status: f.status,
    reason: f.reason,
    refusal: f.refusal,
    error: f.error,
    disposition: f.disposition,
    sessionId: f.sessionId,
    pipelineRunId: f.pipelineRunId,
    startedAt: f.startedAt.toISOString(),
    finishedAt: iso(f.finishedAt),
    durationSeconds: f.finishedAt
      ? Math.max(0, Math.round((f.finishedAt.getTime() - f.startedAt.getTime()) / 1000))
      : null,
    produced,
    attentionGroup: fireGroupOf(f, produced, waitingOn),
    waitingOn,
  };
}

function reportWaitOf(r: ReportFacts, viewer: AutomationViewer): AutomationWaitingOn {
  const v = r.view;
  if (v.triage === 'new') return triageWaitOf(r.fire, viewer);
  if (v.triage === 'filed' && v.feedback) {
    return {
      kind: 'feedback',
      who: v.feedback.key,
      act: '',
      rule: `filed as ${v.feedback.key}, at ${v.feedback.phase}`,
      ref: v.feedback.key,
      dueAt: null,
    };
  }
  if (v.triage === 'filed' && r.issue) {
    return {
      kind: 'issue',
      who: r.issue.key,
      act: '',
      rule: `filed as ${r.issue.key}, at ${r.issue.status}`,
      ref: r.issue.key,
      dueAt: null,
    };
  }
  return NOBODY(`triaged ${v.triage}`);
}

function reportGroupOf(r: AgentReportView, wait: AutomationWaitingOn): ReportGroup {
  if (r.triage === 'new') return wait.kind === 'you' ? 'needs_you' : 'waiting';
  return r.triage === 'filed' ? 'filed' : 'closed';
}

export function reportStandingOf(r: ReportFacts, viewer: AutomationViewer): ReportStanding {
  const waitingOn = reportWaitOf(r, viewer);
  const fire = r.fire
    ? { id: r.fire.id, scheduleId: r.fire.scheduleId, scheduleName: r.fire.scheduleName }
    : null;
  return { ...r.view, fire, attentionGroup: reportGroupOf(r.view, waitingOn), waitingOn };
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Reports waiting for triage first, high severity then oldest; then the triaged, newest first. */
export function reportOrder(a: ReportStanding, b: ReportStanding): number {
  const aNew = a.triage === 'new';
  const bNew = b.triage === 'new';
  if (aNew !== bNew) return aNew ? -1 : 1;
  if (aNew) {
    const sev = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
    return sev !== 0 ? sev : a.createdAt.localeCompare(b.createdAt);
  }
  return (b.triagedAt ?? b.createdAt).localeCompare(a.triagedAt ?? a.createdAt);
}
