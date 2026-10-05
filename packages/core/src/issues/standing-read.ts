/**
 * Gathers the facts `standing.ts` derives from, for a project's issues at once: the work state and
 * lease, whether a box is moving it, open human questions, live `blocks` edges, criteria verdicts,
 * the requirement and business criteria it traces to, its primary module, the feedback routed to
 * it and its last activity. One query per fact over the whole page, never one per row.
 */

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type {
  IssueAttentionGroup,
  IssueLeaseView,
  IssueStandingDetail,
  IssueStandingList,
  IssueStandingRow,
  IssueStandingScope,
  IssueStepHandoff,
} from '@forge/contracts/issue-standing';
import type { WorkStep } from '@forge/contracts/issue-vocabulary';
import { changedSincePlan } from '@forge/contracts/requirements';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import type { WorkStepEntry } from '../db/schema-issue-work-state.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { holds } from '../permissions/index.js';
import { type BlockingEdge, blockerUnsettledSql, blockingEdgesIn } from './blocked-by.js';
import { designHoldPhrase } from './design-delivery.js';
import { issueWorkMovingSql } from './issue-lease.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { loadIssuePark } from './park-view.js';
import { safeHydratePipelineHealthForIssues } from './pipeline-health.js';
import { approvalRequired, handoffContextsOf, holdsOpenHumanQuestion } from './ports.js';
import { classifyLease } from './session-claim.js';
import {
  deriveIssueStanding,
  type IssueStandingInput,
  type StandingEdge,
  wavesOf,
} from './standing.js';
import { issueBlockerOf } from './standing-blocker.js';
import {
  criteriaOf,
  feedbackOf,
  modulesOf,
  type RequirementRaw,
  requirementsOf,
} from './standing-facts-read.js';
import { type StepDurationFact, stepOutcomesOf } from './step-outcomes.js';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';

/** The most rows one read answers; the list says so when a scope holds more. */
export const STANDING_LIMIT = 500;

const DONE_SQL = sql`(${sql.join(
  ISSUE_TERMINAL_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;

interface IssueRowRaw {
  id: string;
  iss_seq: number;
  title: string;
  status: IssueStatus;
  waiting_kind: string | null;
  merged_at: string | null;
  priority: string;
  category: string | null;
  complexity: string | null;
  assignee_id: string | null;
  created_by_id: string | null;
  requirement_id: string | null;
  planned_revision: number | null;
  planned_baseline_seq: number | null;
  plan: string | null;
  created_at: string;
  updated_at: string;
  step: WorkStep | null;
  step_started_at: string | null;
  steps: WorkStepEntry[] | null;
  lease: unknown;
  branch: string | null;
  head_sha: string | null;
  left_status: IssueStatus | null;
  ws_updated_at: string | null;
  last_activity: string | null;
  moving: boolean;
  owes_answer: boolean;
  holds_dependents: boolean;
}

function scopeSql(scope: IssueStandingScope | 'one', key: number | null): SQL {
  if (scope === 'one') return sql`AND i.iss_seq = ${key}`;
  if (scope === 'open') return sql`AND i.status NOT IN ${DONE_SQL}`;
  if (scope === 'closed') return sql`AND i.status IN ${DONE_SQL}`;
  return sql``;
}

async function issueRows(projectId: string, where: SQL, limit: number): Promise<IssueRowRaw[]> {
  return rowsOf<IssueRowRaw>(
    await db.execute(sql`
      SELECT i.id, i.iss_seq, i.title, i.status, i.waiting_kind, i.merged_at, i.priority, i.category, i.complexity,
             i.assignee_id, i.created_by_id, i.requirement_id, i.planned_revision,
             i.planned_baseline_seq,
             CASE WHEN btrim(coalesce(i.plan, '')) <> '' THEN 'written' END AS plan,
             i.created_at, i.updated_at,
             w.step, w.step_started_at, w.steps, w.lease, w.branch, w.head_sha, w.left_status,
             w.updated_at AS ws_updated_at,
             (SELECT max(a.created_at) FROM activity_log a WHERE a.issue_id = i.id) AS last_activity,
             ${holdsOpenHumanQuestion(sql`i.id`)} AS owes_answer,
             ${blockerUnsettledSql(sql`i`)} AS holds_dependents,
             ${issueWorkMovingSql({
               issueId: sql`i.id`,
               projectId: sql`i.project_id`,
               issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
             })} AS moving
        FROM issues i
        LEFT JOIN issue_work_state w ON w.issue_id = i.id
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL ${where}
       ORDER BY i.updated_at DESC
       LIMIT ${limit}`),
  );
}

function leaseOf(raw: unknown, now: Date): IssueLeaseView | null {
  if (raw === null || raw === undefined) return null;
  const read = classifyLease({ lease: raw, now, fanout: 1 });
  if (read.verdict === 'none') return null;
  return {
    holder: read.holder,
    verdict: read.verdict,
    expiresAt: read.expiresAt?.toISOString() ?? null,
  };
}

const latest = (...times: (string | null)[]) =>
  new Date(
    Math.max(...times.filter((t): t is string => t !== null).map((t) => new Date(t).getTime())),
  );

export interface StandingViewer {
  userId: string;
}

async function viewerOf(viewer: StandingViewer | null, projectId: string) {
  if (!viewer) return null;
  const [access, people] = await Promise.all([
    effectiveProjectRole(viewer.userId, projectId),
    peopleOf([viewer.userId]),
  ]);
  // A person's wait addresses its viewer as "You" only when the viewer is a person.
  const person = people.get(viewer.userId)?.kind !== 'agent';
  return {
    userId: viewer.userId,
    canWrite: person && access !== null && holds(access, 'project.write'),
  };
}

type Facts = {
  key: (seq: number) => string;
  edges: BlockingEdge[];
  criteria: Awaited<ReturnType<typeof criteriaOf>>;
  requirements: Awaited<ReturnType<typeof requirementsOf>>;
  modules: Awaited<ReturnType<typeof modulesOf>>;
  feedback: Awaited<ReturnType<typeof feedbackOf>>;
  people: Awaited<ReturnType<typeof peopleOf>>;
  releaseApproval: boolean;
  viewer: Awaited<ReturnType<typeof viewerOf>>;
  now: Date;
};

/** One end of a live `blocks` edge, as the standing reads it: the blocker or the dependent. */
function edgeEnd(e: BlockingEdge, side: 'from' | 'to', key: Facts['key']): StandingEdge {
  const design = side === 'from' ? e.fromDesign : e.toDesign;
  return {
    id: side === 'from' ? e.fromId : e.toId,
    key: key(side === 'from' ? e.fromSeq : e.toSeq),
    title: side === 'from' ? e.fromTitle : e.toTitle,
    status: side === 'from' ? e.fromStatus : e.toStatus,
    merged: side === 'from' ? e.fromMerged : e.toMerged,
    step: side === 'from' ? e.fromStep : e.toStep,
    designHold: design?.length ? designHoldPhrase(design) : null,
    holds: e.holds,
  };
}

function requirementRef(
  r: IssueRowRaw,
  req: RequirementRaw | undefined,
  mine: Facts['criteria'],
): IssueStandingInput['requirement'] {
  if (!req) return null;
  return {
    key: `REQ-${req.req_seq}`,
    title: req.title,
    criteria: [...new Set(mine.map((c) => c.bc_code).filter((c): c is string => !!c))].sort(
      (a, b) => Number(a.slice(3)) - Number(b.slice(3)),
    ),
    plannedRevision: r.planned_revision,
    currentRevision: req.current_revision,
    changedSincePlan: changedSincePlan({
      plan: r.plan,
      plannedRevision: r.planned_revision,
      currentRevision: req.current_revision,
      plannedBaselineSeq: r.planned_baseline_seq,
      latestBaselineSeq: req.latest_baseline_seq,
    }),
  };
}

function standingInputOf(r: IssueRowRaw, f: Facts): IssueStandingInput {
  const mine = f.criteria.filter((c) => c.issue_id === r.id);
  const ownerId = r.assignee_id ?? r.created_by_id;
  const owner = ownerId ? f.people.get(ownerId) : undefined;
  return {
    status: r.status,
    leftStatus: r.left_status,
    holdsDependents: r.holds_dependents,
    waitingKind: r.waiting_kind,
    merged: r.merged_at !== null,
    step: r.step,
    stepStartedAt: r.step_started_at ? new Date(r.step_started_at) : null,
    lease: leaseOf(r.lease, f.now),
    inFlight: r.moving,
    owesAnswer: r.owes_answer,
    blockedBy: f.edges.filter((e) => e.toId === r.id).map((e) => edgeEnd(e, 'from', f.key)),
    blocks: f.edges.filter((e) => e.fromId === r.id).map((e) => edgeEnd(e, 'to', f.key)),
    criteria: {
      total: mine.length,
      passing: mine.filter((c) => c.stands && (c.verdict === 'pass' || c.verdict === 'short'))
        .length,
      failing: mine.filter((c) => c.verdict === 'fail').length,
      skipped: mine.filter((c) => c.verdict === 'skipped').length,
    },
    requirement: requirementRef(
      r,
      r.requirement_id ? f.requirements.get(r.requirement_id) : undefined,
      mine,
    ),
    module: f.modules.get(r.id) ?? null,
    feedback: f.feedback.get(r.id) ?? [],
    branch: r.branch,
    headSha: r.head_sha,
    owner: ownerId
      ? { id: ownerId, name: owner?.name ?? null, kind: owner?.kind ?? 'human' }
      : null,
    touchedAt: latest(r.updated_at, r.ws_updated_at, r.last_activity),
    releaseApproval: f.releaseApproval,
    viewer: f.viewer,
    now: f.now,
  };
}

async function standingRows(
  projectId: string,
  raws: readonly IssueRowRaw[],
  viewer: StandingViewer | null,
  now: Date,
): Promise<IssueStandingRow[]> {
  if (raws.length === 0) return [];
  const ids = raws.map((r) => r.id);
  const [prefix, edges, criteria, modules, feedback, releaseApproval, who] = await Promise.all([
    activeIssuePrefix(projectId),
    blockingEdgesIn(db, projectId, ids),
    criteriaOf(projectId, ids),
    modulesOf(projectId, ids),
    feedbackOf(ids),
    approvalRequired(projectId),
    viewerOf(viewer, projectId),
  ]);
  const [requirements, people] = await Promise.all([
    requirementsOf([...new Set(raws.map((r) => r.requirement_id).filter((x): x is string => !!x))]),
    peopleOf(raws.flatMap((r) => [r.assignee_id, r.created_by_id])),
  ]);
  const key = (seq: number) => formatIssueRef(prefix, seq);
  const facts: Facts = {
    key,
    edges,
    criteria,
    requirements,
    modules,
    feedback,
    people,
    releaseApproval,
    viewer: who,
    now,
  };
  const inputs = raws.map((r): [IssueRowRaw, IssueStandingInput] => [r, standingInputOf(r, facts)]);
  const groups = new Map<string, IssueAttentionGroup>(
    inputs.map(([r, input]) => [r.id, deriveIssueStanding(input).attentionGroup]),
  );
  const waves = wavesOf([
    ...inputs.map(([r, input]) => ({
      id: r.id,
      holds: r.holds_dependents,
      blockedBy: input.blockedBy.map((b) => b.id),
    })),
    // a blocker outside the page still decides its dependents' wave by whether it holds
    ...edges
      .filter((e) => !groups.has(e.fromId))
      .map((e) => ({ id: e.fromId, holds: e.holds, blockedBy: [] as string[] })),
  ]);
  return inputs.map(([r, input]) => ({
    id: r.id,
    key: key(r.iss_seq),
    title: r.title,
    status: r.status,
    priority: r.priority,
    category: r.category,
    complexity: r.complexity,
    assigneeId: r.assignee_id,
    createdById: r.created_by_id,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    standing: deriveIssueStanding(input, groups, waves.get(r.id) ?? null),
  }));
}

async function scopeCounts(projectId: string) {
  const [row] = rowsOf<{ open: number; closed: number }>(
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE status NOT IN ${DONE_SQL})::int AS open,
             count(*) FILTER (WHERE status IN ${DONE_SQL})::int AS closed
        FROM issues WHERE project_id = ${projectId} AND archived_at IS NULL`),
  );
  return { open: row?.open ?? 0, closed: row?.closed ?? 0 };
}

/** The list a project's Issues screen reads: one scope, newest write first, at most `limit` rows. */
export async function listIssueStanding(
  projectId: string,
  scope: IssueStandingScope,
  viewer: StandingViewer | null,
  now: Date = new Date(),
  limit: number = STANDING_LIMIT,
): Promise<IssueStandingList> {
  const [raws, counts, releaseApproval] = await Promise.all([
    issueRows(projectId, scopeSql(scope, null), limit),
    scopeCounts(projectId),
    approvalRequired(projectId),
  ]);
  const issues = await standingRows(projectId, raws, viewer, now);
  return {
    issues,
    counts: {
      open: counts.open,
      closed: counts.closed,
      all: counts.open + counts.closed,
      needsYou: issues.filter((i) => i.standing.attentionGroup === 'needs_you').length,
      blocked: issues.filter((i) => i.standing.blockedBy.length > 0).length,
      blocking: issues.filter((i) => i.standing.blocks.length > 0).length,
    },
    returned: issues.length,
    limit,
    releaseApproval,
  };
}

/** One issue's standing with its step log, for the peek and the full page; null when absent. */
export async function readIssueStanding(
  projectId: string,
  issSeq: number,
  viewer: StandingViewer | null,
  now: Date = new Date(),
): Promise<IssueStandingDetail | null> {
  const raws = await issueRows(projectId, scopeSql('one', issSeq), 1);
  const raw = raws[0];
  if (!raw) return null;
  const [[row], releaseApproval, health, park, steps] = await Promise.all([
    standingRows(projectId, raws, viewer, now),
    approvalRequired(projectId),
    safeHydratePipelineHealthForIssues(projectId, [raw.id]),
    loadIssuePark(raw.id),
    stepFactsOf(projectId, raw.id),
  ]);
  if (!row) return null;
  const h = health.get(raw.id);
  const blocker = issueBlockerOf({
    status: raw.status,
    leftStatus: raw.left_status,
    pausedRun: h?.pausedRun ?? null,
    gate: h?.waitingOn ?? null,
    park,
    blockedBy: row.standing.blockedBy,
  });
  const active = h?.activeSession?.status === 'running' ? h.activeSession.skill : null;
  return {
    ...row,
    steps: raw.steps ?? [],
    releaseApproval,
    blocker,
    stepOutcomes: stepOutcomesOf({ ...steps, activeStep: active }),
  };
}

/** The handoffs, step durations and newest failed job one issue's step outcomes are read from. */
async function stepFactsOf(projectId: string, issueId: string) {
  const [contexts, durations, failed] = await Promise.all([
    handoffContextsOf(projectId, issueId),
    db.execute(sql`
      SELECT run_id, step, duration_seconds, cost_usd, coalesce(finished_at, started_at) AS at
        FROM pipeline_run_step_durations
       WHERE project_id = ${projectId} AND issue_id = ${issueId} AND duration_seconds IS NOT NULL`),
    db.execute(sql`
      SELECT type FROM jobs WHERE issue_id = ${issueId} AND status = 'failed'
       ORDER BY finished_at DESC NULLS LAST LIMIT 1`),
  ]);
  const handoffs: IssueStepHandoff[] = contexts.flatMap((c) =>
    c.step
      ? [
          {
            id: c.id,
            step: c.step,
            attempt: c.attempt,
            pipelineRunId: c.pipelineRunId,
            payload:
              c.payload && typeof c.payload === 'object'
                ? (c.payload as Record<string, unknown>)
                : null,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          },
        ]
      : [],
  );
  const facts: StepDurationFact[] = rowsOf<{
    run_id: string;
    step: string;
    duration_seconds: number;
    cost_usd: number | null;
    at: string | Date;
  }>(durations).map((d) => ({
    runId: d.run_id,
    step: d.step,
    durationSeconds: Number(d.duration_seconds),
    costUsd: Number(d.cost_usd ?? 0),
    at: new Date(d.at).toISOString(),
  }));
  const [last] = rowsOf<{ type: string }>(failed);
  return { handoffs, durations: facts, failedStep: last?.type ?? null };
}
