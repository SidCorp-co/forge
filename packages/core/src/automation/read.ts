// cm:why the automation read model's three reads (ISS-114): the standing of a project's schedules,
// fires and reports, one fire with what it produced, and one schedule with its fires; REST, MCP and
// needs-you all call these, with the viewer `automationViewerOf` builds

import {
  AUTOMATION_TRIAGED_REPORTS,
  type AutomationStandingResponse,
  type FireDetailResponse,
  type FireProposal,
  type ReportDetailResponse,
  type ScheduleDetailResponse,
  type ScheduleStanding,
} from '@forge/contracts/automation-standing';
import { readThresholds } from '../admin/thresholds.js';
import { loadProjectAccess } from '../lib/authz.js';
import { lastFires } from '../schedules/fires.js';
import { readScheduleStreaks } from '../schedules/streak.js';
import {
  type FireRow,
  fireFacts,
  producedItems,
  reportCounts,
  reportFacts,
  reportRow,
  reportRows,
  scheduleFacts,
  stewardActions,
} from './facts.js';
import {
  type AutomationViewer,
  fireProposals,
  fireStandingOf,
  reportOrder,
  reportStandingOf,
  type ScheduleFacts,
  type StewardAction,
  scheduleStandingOf,
} from './standing.js';
import { holds } from '../permissions/index.js';

/** The viewer a read addresses its waits to: null when the caller is not a project member. */
export async function automationViewerOf(
  projectId: string,
  userId: string,
): Promise<AutomationViewer | null> {
  const access = await loadProjectAccess(projectId, userId);
  if (!holds(access, 'project.read')) return null;
  return {
    userId,
    canWrite: holds(access, 'project.write'),
    isAdmin: holds(access, 'project.admin'),
  };
}

type Standings = Map<string, ScheduleStanding & { facts: ScheduleFacts }>;

async function schedulesOf(
  projectId: string,
  viewer: AutomationViewer,
  now: Date,
  scheduleId?: string,
): Promise<{ standings: Standings; failStreak: number }> {
  const [facts, streaks, last, thresholds] = await Promise.all([
    scheduleFacts(projectId, scheduleId),
    readScheduleStreaks({ projectId, ...(scheduleId ? { scheduleId } : {}) }),
    lastFires(projectId, scheduleId ? [scheduleId] : undefined),
    readThresholds(),
  ]);
  const streakOf = new Map(streaks.map((s) => [s.scheduleId, s]));
  const ctx = { viewer, failStreak: thresholds.scheduleFailStreak, now };
  const standings: Standings = new Map(
    facts.map((s) => [
      s.id,
      {
        ...scheduleStandingOf(s, streakOf.get(s.id) ?? null, last.get(s.id) ?? null, ctx),
        facts: s,
      },
    ]),
  );
  return { standings, failStreak: thresholds.scheduleFailStreak };
}

const publicStanding = ({ facts: _facts, ...s }: ScheduleStanding & { facts: ScheduleFacts }) => s;

async function firesOf(fires: readonly FireRow[], standings: Standings, viewer: AutomationViewer) {
  const actions = await stewardActions(fires.flatMap((f) => (f.sessionId ? [f.sessionId] : [])));
  const actionsOf = (f: FireRow): StewardAction[] | null =>
    f.sessionId ? (actions.get(f.sessionId) ?? null) : null;
  const proposals: FireProposal[] = fires.flatMap((f) => fireProposals(f, actionsOf(f)));
  const standingsOut = fires.map((f) => ({
    row: f,
    standing: fireStandingOf(
      f,
      fireProposals(f, actionsOf(f)).length,
      standings.get(f.scheduleId),
      viewer,
    ),
  }));
  return { fires: standingsOut, proposals };
}

async function reportsOf(
  scope: { projectId: string; scheduleId?: string },
  viewer: AutomationViewer,
) {
  const views = await reportRows({ ...scope, triaged: AUTOMATION_TRIAGED_REPORTS });
  return (await reportFacts(views)).map((r) => reportStandingOf(r, viewer)).sort(reportOrder);
}

export async function readAutomationStanding(
  projectId: string,
  viewer: AutomationViewer,
  opts: { firesLimit: number },
  now: Date = new Date(),
): Promise<AutomationStandingResponse> {
  const { standings, failStreak } = await schedulesOf(projectId, viewer, now);
  const [fired, reports, counts] = await Promise.all([
    fireFacts({ projectId, limit: opts.firesLimit }),
    reportsOf({ projectId }, viewer),
    reportCounts(projectId),
  ]);
  const { fires, proposals } = await firesOf(fired.fires, standings, viewer);
  return {
    generatedAt: now.toISOString(),
    failStreak,
    schedules: [...standings.values()].map(publicStanding),
    fires: fires.map((f) => f.standing),
    firesTotal: fired.total,
    firesHasMore: fired.total > fires.length,
    reports,
    reportCounts: counts,
    proposals,
  };
}

export async function readScheduleDetail(
  projectId: string,
  scheduleId: string,
  viewer: AutomationViewer,
  opts: { firesLimit: number },
  now: Date = new Date(),
): Promise<ScheduleDetailResponse | null> {
  const { standings } = await schedulesOf(projectId, viewer, now, scheduleId);
  const standing = standings.get(scheduleId);
  if (!standing) return null;
  const [fired, reports] = await Promise.all([
    fireFacts({ projectId, scheduleId, limit: opts.firesLimit }),
    reportsOf({ projectId, scheduleId }, viewer),
  ]);
  const { fires, proposals } = await firesOf(fired.fires, standings, viewer);
  return {
    schedule: publicStanding(standing),
    fires: fires.map((f) => ({ ...f.standing, output: f.row.output })),
    firesTotal: fired.total,
    firesHasMore: fired.total > fires.length,
    reports,
    proposals,
  };
}

export async function readFireDetail(
  projectId: string,
  fireId: string,
  viewer: AutomationViewer,
  now: Date = new Date(),
): Promise<FireDetailResponse | null> {
  const fired = await fireFacts({ projectId, fireId, limit: 1 });
  const row = fired.fires[0];
  if (!row) return null;
  const { standings } = await schedulesOf(projectId, viewer, now, row.scheduleId);
  const standing = standings.get(row.scheduleId);
  if (!standing) return null;
  const { fires, proposals } = await firesOf([row], standings, viewer);
  const fire = fires[0];
  if (!fire) return null;
  return {
    fire: { ...fire.standing, output: row.output },
    schedule: publicStanding(standing),
    produced: await producedItems(row, proposals),
  };
}

export async function readReportDetail(
  projectId: string,
  reportId: string,
  viewer: AutomationViewer,
): Promise<ReportDetailResponse | null> {
  const [facts] = await reportFacts(await reportRow(projectId, reportId));
  return facts ? { report: reportStandingOf(facts, viewer) } : null;
}
