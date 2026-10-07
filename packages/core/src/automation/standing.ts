// Where a schedule, a fire and an agent report stand and whom each waits on, derived from what
// `automation/facts.ts` read and nothing else (design automation rev 1, steps streak, settle,
// needs_you and wait_triage; ISS-114): pure, so every rule is a unit test, and no screen derives one

import type { AgentReportView } from '@forge/contracts/agent-reports';
import type {
  AutomationAct,
  AutomationPerson,
  AutomationWaitingKind,
  FireGroup,
  FireProduced,
  FireProposal,
  FireStanding,
  ReportFireRef,
  ReportGroup,
  ReportStanding,
  ScheduleGroup,
  ScheduleLastFire,
  ScheduleStanding,
  ScheduleState,
} from '@forge/contracts/automation-standing';
import { type Said, say, sayEn } from '@forge/contracts/said';
import { scheduleWritePermission } from '@forge/contracts/schedules';
import {
  holdersWho,
  nobodyHoldsAct,
  nobodyWaits,
  type WaitingOn,
  waitingOn,
} from '@forge/contracts/standing';
import { type LastFire, type ScheduleStreak, streakFails } from './ports.js';

export interface AutomationViewer {
  userId: string;
  /** member or above: may triage a report. */
  canWrite: boolean;
  /** admin or above: may change any schedule, taking over one that is not theirs. */
  isAdmin: boolean;
  /** Who a group's wait names, by name: the project's admins and writers (`permissions:namedHolders`). */
  holders: { admins: readonly string[]; writers: readonly string[] };
}

export interface ScheduleFacts {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  cron: string;
  enabled: boolean;
  targetProjectSlug: string | null;
  nextRunAt: Date | null;
  createdAt: Date;
  owner: AutomationPerson | null;
}

type LastFireFacts = LastFire;

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

/** What each owed act says (`AutomationAct`). */
const ACT_SAID: Record<AutomationAct, Said> = {
  triage_report: say('standing.act.triageReport'),
  fix_schedule: say('standing.act.fixSchedule'),
  reassign_owner: say('standing.act.takeOverSchedule'),
};

const YOU = say('standing.who.you');

const owed = (
  kind: AutomationWaitingKind,
  who: Said,
  act: AutomationAct,
  rule: Said,
): AutomationWaitingOn => waitingOn(kind, { who, act: ACT_SAID[act], rule });

function personWait(
  person: AutomationPerson,
  viewer: AutomationViewer,
  act: AutomationAct,
  rule: Said,
): AutomationWaitingOn {
  if (person.id === viewer.userId) return owed('you', YOU, act, rule);
  const who = person.name
    ? say('standing.who.named', { name: person.name })
    : say('standing.who.scheduleOwner');
  return owed('person', who, act, rule);
}

function groupWait(
  kind: 'admins' | 'writers',
  viewer: AutomationViewer,
  act: AutomationAct,
  rule: Said,
): AutomationWaitingOn {
  const mine = kind === 'admins' ? viewer.isAdmin : viewer.canWrite;
  if (mine) return owed('you', YOU, act, rule);
  const holders = viewer.holders[kind];
  if (holders.length === 0) {
    const permission = kind === 'admins' ? 'project.admin' : 'project.write';
    return owed('none', holdersWho(holders), act, nobodyHoldsAct(rule, permission));
  }
  return owed(kind, holdersWho(holders), act, rule);
}

function scheduleStateOf(
  s: Pick<ScheduleFacts, 'enabled' | 'owner'>,
  streak: Pick<ScheduleStreak, 'streak' | 'lastCountedAt'> | null,
  lastFire: Pick<LastFireFacts, 'status'> | null,
  failStreak: number,
  now: Date,
): { state: ScheduleState; rule: Said } {
  if (!s.enabled) return { state: 'off', rule: say('automation.state.off') };
  if (!s.owner) {
    return {
      state: 'owner_gone',
      rule: say('automation.state.ownerGone'),
    };
  }
  if (streak && streakFails(streak, s, failStreak, now)) {
    return {
      state: 'failing',
      rule: say('automation.state.failing', { n: streak.streak, limit: failStreak }),
    };
  }
  if (lastFire?.status === 'running')
    return { state: 'firing', rule: say('automation.state.firing') };
  return {
    state: 'on',
    rule:
      streak && streak.streak > 0
        ? say('automation.state.underStreak', { n: streak.streak, limit: failStreak })
        : say('automation.state.on'),
  };
}

function scheduleWaitOf(
  state: ScheduleState,
  s: ScheduleFacts,
  viewer: AutomationViewer,
): AutomationWaitingOn {
  if (state === 'failing' && s.owner) {
    return personWait(s.owner, viewer, 'fix_schedule', say('automation.rule.failing'));
  }
  if (state === 'owner_gone') {
    return groupWait('admins', viewer, 'reassign_owner', say('automation.rule.ownerGone'));
  }
  if (state === 'off') return NOBODY(say('automation.rule.off'));
  return NOBODY(
    s.nextRunAt
      ? say('automation.rule.nextFire', { at: s.nextRunAt.toISOString() })
      : say('automation.rule.noNextFire'),
  );
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
    targetProjectSlug: s.targetProjectSlug,
    state,
    rule: sayEn(rule),
    says: { rule },
    nextFireAt: s.enabled ? iso(s.nextRunAt) : null,
    owner: s.owner,
    streak: streak?.streak ?? 0,
    lastFire: lastFireOf(lastFire),
    attentionGroup: scheduleGroupOf(state, waitingOn),
    waitingOn,
    viewerMay: viewerMayOf(s, ctx.viewer),
    createdAt: s.createdAt.toISOString(),
  };
}

function viewerMayOf(s: Pick<ScheduleFacts, 'owner'>, viewer: AutomationViewer) {
  const needs = scheduleWritePermission(s.owner?.id ?? null, viewer.userId);
  const edit = needs === 'project.admin' ? viewer.isAdmin : viewer.canWrite;
  return { edit, takeOver: edit && needs === 'project.admin' };
}

/** Who triages a report: its fire's schedule owner first, otherwise any member with write access. */
function triageWaitOf(
  fire: { owner: AutomationPerson | null } | null,
  viewer: AutomationViewer,
): AutomationWaitingOn {
  if (fire?.owner) {
    return personWait(fire.owner, viewer, 'triage_report', say('automation.rule.toOwner'));
  }
  return groupWait('writers', viewer, 'triage_report', say('automation.rule.toWriters'));
}

const harnessTriage = (): AutomationWaitingOn =>
  owed(
    'writers',
    say('automation.who.harnessTriage'),
    'triage_report',
    say('automation.rule.harness'),
  );

/** The steward actions a fire's session proposed or applied; feedback and skipped are not proposals. */
function proposalsOf(actions: readonly StewardAction[] | null): StewardAction[] {
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

function producedOf(f: FireFacts, proposals: number): FireProduced {
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
    return waitingOn(
      wait.kind,
      {
        ...wait.says,
        rule: say('automation.rule.reportsWait', { n: f.newReports, rule: wait.says.rule }),
      },
      { ref: wait.ref, dueAt: wait.dueAt },
    );
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
  return NOBODY(
    say(f.status === 'running' ? 'automation.rule.running' : 'automation.rule.fireWaitsOnNobody'),
  );
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
  if (v.triage === 'new') return r.fire ? triageWaitOf(r.fire, viewer) : harnessTriage();
  if (v.triage === 'filed' && v.feedback) {
    const key = v.feedback.key;
    return waitingOn(
      'feedback',
      {
        who: say('standing.who.named', { name: key }),
        act: say('standing.act.none'),
        rule: say('automation.rule.filedFeedback', { key, phase: v.feedback.phase }),
      },
      { ref: key },
    );
  }
  if (v.triage === 'filed' && r.issue) {
    const key = r.issue.key;
    return waitingOn(
      'issue',
      {
        who: say('standing.who.named', { name: key }),
        act: say('standing.act.none'),
        rule: say('automation.rule.filedIssue', { key, status: r.issue.status }),
      },
      { ref: key },
    );
  }
  return NOBODY(say('automation.rule.triaged', { triage: v.triage }));
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
