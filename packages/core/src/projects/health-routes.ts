import { NON_OPEN_STATUSES } from '@forge/contracts/issue-machine';
import { inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { projects } from '../db/schema.js';
import {
  countClaimHeldIssuesByProject,
  type LoopMonitorCoverage,
  loopMonitorCoverage,
} from '../jobs/loop-monitor-axis.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type BlockerRow, readHealthAggregates } from './health-aggregates.js';

interface ProjectHealthRow {
  /** Project UUID — needed by web-v2 to join the `GET /api/projects` list rows
   *  (which carry `id` but no metrics) against this health rollup. */
  id: string;
  projectName: string;
  projectSlug: string;
  throughput: number;
  totalActive: number;
  statusDistribution: Record<string, number>;
  blockers: Array<{ issueId: string; documentId: string; status: string }>;
  pendingEscalations: number;
  avgCycleTimeDays: number;
  /** Pipeline runs currently `running` or `paused`. */
  liveRuns: number;
  /** Runners in the `online` state. */
  runnerCount: number;
  /** Trailing-24h spend (USD) from the `pipeline_run_step_durations` view. */
  spend24hUsd: number;
  /** True total project membership count. */
  memberCount: number;
  /** Up to 5 email-derived avatar initials (no display-name column exists). */
  members: string[];
  /** ISO timestamp of the most recent issue/run activity, or `null`. */
  lastActivityAt: string | null;
  /** ISS-1273 — which axis the loop monitor sweeps for this project, and how many non-terminal
   *  issues sit on the claim lane none of its hops reaches. A zero says the lane is empty; the
   *  field's absence, which is what callers had before, said nothing at all. */
  loopMonitor: LoopMonitorCoverage;
}

/** First 2 chars of the email local-part, uppercased — the avatar initials. */
function emailInitials(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local.slice(0, 2).toUpperCase();
}

const MEMBER_AVATAR_CAP = 5;
const PER_PROJECT_BLOCKER_CAP = 5;

export const projectHealthRoutes = new Hono<{ Variables: AuthVars }>();
projectHealthRoutes.use('/health', requireAuth(), assertEmailVerified());

function groupBlockers(rows: BlockerRow[]): Map<string, ProjectHealthRow['blockers']> {
  const byProject = new Map<string, ProjectHealthRow['blockers']>();
  for (const r of rows) {
    const arr = byProject.get(r.projectId) ?? [];
    if (arr.length >= PER_PROJECT_BLOCKER_CAP) continue;
    arr.push({
      issueId: formatIssueRef(r.issuePrefix, r.issSeq),
      documentId: r.id,
      status: r.status,
    });
    byProject.set(r.projectId, arr);
  }
  return byProject;
}

projectHealthRoutes.get('/health', async (c) => {
  const userId = c.get('userId');

  // Caller sees their visible projects (explicit member OR org owner/admin).
  const visibleIds = await loadVisibleProjectIds(userId);
  if (visibleIds.length === 0) return c.json([]);

  const visibleProjects = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
    })
    .from(projects)
    .where(inArray(projects.id, visibleIds));

  if (visibleProjects.length === 0) return c.json([]);

  const projectIds = visibleProjects.map((p) => p.id);
  const agg = await readHealthAggregates(projectIds);
  const claimHeldByProject = await countClaimHeldIssuesByProject(projectIds);

  const distByProject = new Map<string, Record<string, number>>();
  for (const r of agg.statusRows) {
    const dist = distByProject.get(r.projectId) ?? {};
    dist[r.status] = Number(r.n);
    distByProject.set(r.projectId, dist);
  }

  const blockersByProject = groupBlockers(agg.blockerRowsAll);

  const throughputByProject = new Map<string, number>();
  for (const r of agg.throughputRows) throughputByProject.set(r.projectId, Number(r.n));

  const cycleByProject = new Map<string, number>();
  for (const r of agg.cycleRows) {
    if (r.avg_days != null) cycleByProject.set(r.project_id, Number(r.avg_days));
  }

  const liveRunsByProject = new Map<string, number>();
  for (const r of agg.liveRunRows) liveRunsByProject.set(r.projectId, Number(r.n));

  const runnersByProject = new Map<string, number>();
  for (const r of agg.runnerRows) runnersByProject.set(r.projectId, Number(r.n));

  const spendByProject = new Map<string, number>();
  for (const r of agg.spendRows) spendByProject.set(r.project_id, Number(r.spend));

  // Build the capped avatar list + true count from the ordered member rows.
  const memberCountByProject = new Map<string, number>();
  const membersByProject = new Map<string, string[]>();
  for (const r of agg.memberRows) {
    memberCountByProject.set(r.projectId, (memberCountByProject.get(r.projectId) ?? 0) + 1);
    const arr = membersByProject.get(r.projectId) ?? [];
    if (arr.length < MEMBER_AVATAR_CAP) arr.push(emailInitials(r.email));
    membersByProject.set(r.projectId, arr);
  }

  // Merge issue + run activity into a single max-timestamp per project.
  const lastActivityByProject = new Map<string, string | null>();
  const noteActivity = (projectId: string, lastAt: string | null) => {
    if (!lastAt) return;
    const cur = lastActivityByProject.get(projectId);
    if (!cur || lastAt > cur) lastActivityByProject.set(projectId, lastAt);
  };
  for (const r of agg.issueActivityRows) noteActivity(r.projectId, r.lastAt);
  for (const r of agg.runActivityRows) noteActivity(r.projectId, r.lastAt);

  const result: ProjectHealthRow[] = visibleProjects.map((p) => {
    const dist = distByProject.get(p.id) ?? {};
    let totalActive = 0;
    for (const [status, n] of Object.entries(dist)) {
      if (!NON_OPEN_STATUSES.includes(status as IssueStatus)) totalActive += n;
    }
    return {
      id: p.id,
      projectName: p.name,
      projectSlug: p.slug,
      throughput: throughputByProject.get(p.id) ?? 0,
      totalActive,
      statusDistribution: dist,
      blockers: blockersByProject.get(p.id) ?? [],
      pendingEscalations: dist.needs_info ?? 0,
      avgCycleTimeDays: cycleByProject.get(p.id) ?? 0,
      liveRuns: liveRunsByProject.get(p.id) ?? 0,
      runnerCount: runnersByProject.get(p.id) ?? 0,
      spend24hUsd: spendByProject.get(p.id) ?? 0,
      memberCount: memberCountByProject.get(p.id) ?? 0,
      members: membersByProject.get(p.id) ?? [],
      lastActivityAt: lastActivityByProject.get(p.id) ?? null,
      loopMonitor: loopMonitorCoverage(claimHeldByProject.get(p.id) ?? 0),
    };
  });

  return c.json(result);
});
