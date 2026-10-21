// The automation read model's three reads (ISS-114): the standing of a project's schedules and
// fires, one fire with what it produced, and one schedule with its fires; the REST routes and
// needs-you call these, with the viewer `automationViewerOf` builds

import type {
  AutomationStandingResponse,
  FireDetailResponse,
  FireProposal,
  ScheduleDetailResponse,
  ScheduleStanding,
} from '@forge/contracts/automation-standing';
import { ADMIN_THRESHOLDS } from '../lib/admin-thresholds.js';
import { loadProjectAccess } from '../lib/authz.js';
import { holderNames, holds } from '../permissions/index.js';
import { type FireRow, fireFacts, producedItems, scheduleFacts, stewardActions } from './facts.js';
import { lastFires, readScheduleStreaks } from './ports.js';
import {
  type AutomationViewer,
  fireProposals,
  fireStandingOf,
  type ScheduleFacts,
  type StewardAction,
  scheduleStandingOf,
} from './standing.js';

/** The viewer a read addresses its waits to: null when the caller is not a project member. */
export async function automationViewerOf(
  projectId: string,
  userId: string,
): Promise<AutomationViewer | null> {
  const access = await loadProjectAccess(projectId, userId);
  if (!holds(access, 'project.read')) return null;
  const [admins, writers] = await Promise.all([
    holderNames('project.admin', projectId),
    holderNames('project.write', projectId),
  ]);
  return {
    userId,
    canWrite: holds(access, 'project.write'),
    isAdmin: holds(access, 'project.admin'),
    holders: { admins, writers },
  };
}

type Standings = Map<string, ScheduleStanding & { facts: ScheduleFacts }>;

async function schedulesOf(
  projectId: string,
  viewer: AutomationViewer,
  now: Date,
  scheduleId?: string,
): Promise<{ standings: Standings; failStreak: number }> {
  const [facts, streaks, last] = await Promise.all([
    scheduleFacts(projectId, scheduleId),
    readScheduleStreaks({ projectId, ...(scheduleId ? { scheduleId } : {}) }),
    lastFires(projectId, scheduleId ? [scheduleId] : undefined),
  ]);
  const thresholds = ADMIN_THRESHOLDS;
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

async function firesOf(fires: readonly FireRow[], standings: Standings) {
  const actions = await stewardActions(fires.flatMap((f) => (f.sessionId ? [f.sessionId] : [])));
  const actionsOf = (f: FireRow): StewardAction[] | null =>
    f.sessionId ? (actions.get(f.sessionId) ?? null) : null;
  const proposals: FireProposal[] = fires.flatMap((f) => fireProposals(f, actionsOf(f)));
  const standingsOut = fires.map((f) => ({
    row: f,
    standing: fireStandingOf(f, fireProposals(f, actionsOf(f)).length, standings.get(f.scheduleId)),
  }));
  return { fires: standingsOut, proposals };
}

export async function readAutomationStanding(
  projectId: string,
  viewer: AutomationViewer,
  opts: { firesLimit: number },
  now: Date = new Date(),
): Promise<AutomationStandingResponse> {
  const { standings, failStreak } = await schedulesOf(projectId, viewer, now);
  const fired = await fireFacts({ projectId, limit: opts.firesLimit });
  const { fires, proposals } = await firesOf(fired.fires, standings);
  return {
    generatedAt: now.toISOString(),
    failStreak,
    schedules: [...standings.values()].map(publicStanding),
    fires: fires.map((f) => f.standing),
    firesTotal: fired.total,
    firesHasMore: fired.total > fires.length,
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
  const fired = await fireFacts({ projectId, scheduleId, limit: opts.firesLimit });
  const { fires, proposals } = await firesOf(fired.fires, standings);
  return {
    schedule: publicStanding(standing),
    fires: fires.map((f) => ({ ...f.standing, output: f.row.output })),
    firesTotal: fired.total,
    firesHasMore: fired.total > fires.length,
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
  const { fires, proposals } = await firesOf([row], standings);
  const fire = fires[0];
  if (!fire) return null;
  return {
    fire: { ...fire.standing, output: row.output },
    schedule: publicStanding(standing),
    produced: await producedItems(projectId, row, proposals),
  };
}
