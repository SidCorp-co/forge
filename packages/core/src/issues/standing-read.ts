/**
 * Gathers the facts `standing.ts` derives from, for a project's issues at once: the work state and
 * lease, whether a box is moving it, open human questions, live `blocks` edges, criteria verdicts,
 * the requirement and business criteria it traces to, its primary module, the feedback routed to
 * it and its last activity. One query per fact over the whole page, never one per row.
 */

import type {
  IssueAttentionGroup,
  IssueLeaseView,
  IssueStandingDetail,
  IssueStandingList,
  IssueStandingRow,
  IssueStandingScope,
} from '@forge/contracts/issue-standing';
import type { KernelIssueStatus, WorkStep } from '@forge/contracts/issue-vocabulary';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { WorkStepEntry } from '../db/schema-issue-work-state.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { classifyLease } from '../pipeline/session-claim.js';
import { holdsOpenHumanQuestion } from '../questions/issue-coupling.js';
import { approvalRequired } from '../release-batch/approvals.js';
import { designHoldPhrase, designHoldsOf } from './design-delivery.js';
import { issueWorkMovingSql } from './issue-lease.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import {
  deriveIssueStanding,
  type IssueStandingInput,
  type StandingEdge,
  wavesOf,
} from './standing.js';

/** The most rows one read answers; the list says so when a scope holds more. */
export const STANDING_LIMIT = 500;

const DONE_SQL = sql`('closed', 'dropped')`;

interface IssueRowRaw {
  id: string;
  iss_seq: number;
  title: string;
  status: KernelIssueStatus;
  waiting_kind: string | null;
  merged_at: string | null;
  priority: string;
  category: string | null;
  complexity: string | null;
  assignee_id: string | null;
  created_by_id: string | null;
  requirement_id: string | null;
  planned_revision: number | null;
  created_at: string;
  updated_at: string;
  step: WorkStep | null;
  step_started_at: string | null;
  steps: WorkStepEntry[] | null;
  lease: unknown;
  branch: string | null;
  head_sha: string | null;
  ws_updated_at: string | null;
  last_activity: string | null;
  moving: boolean;
  owes_answer: boolean;
}

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

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
             i.created_at, i.updated_at,
             w.step, w.step_started_at, w.steps, w.lease, w.branch, w.head_sha, w.updated_at AS ws_updated_at,
             (SELECT max(a.created_at) FROM activity_log a WHERE a.issue_id = i.id) AS last_activity,
             ${holdsOpenHumanQuestion(sql`i.id`)} AS owes_answer,
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

interface EdgeRaw {
  from_id: string;
  to_id: string;
  from_seq: number;
  to_seq: number;
  from_title: string;
  to_title: string;
  from_status: KernelIssueStatus;
  to_status: KernelIssueStatus;
  from_merged: boolean;
  to_merged: boolean;
  from_step: WorkStep | null;
  to_step: WorkStep | null;
}

/** Live `blocks` edges touching these issues: `from` holds `to` back. Expired edges count as nothing. */
async function edgesOf(projectId: string, ids: readonly string[]): Promise<EdgeRaw[]> {
  if (ids.length === 0) return [];
  return rowsOf<EdgeRaw>(
    await db.execute(sql`
      SELECT d.from_issue_id AS from_id, d.to_issue_id AS to_id,
             f.iss_seq AS from_seq, t.iss_seq AS to_seq, f.title AS from_title, t.title AS to_title,
             f.status AS from_status, t.status AS to_status,
             f.merged_at IS NOT NULL AS from_merged, t.merged_at IS NOT NULL AS to_merged,
             fw.step AS from_step, tw.step AS to_step
        FROM issue_dependencies d
        JOIN issues f ON f.id = d.from_issue_id
        JOIN issues t ON t.id = d.to_issue_id
        LEFT JOIN issue_work_state fw ON fw.issue_id = f.id
        LEFT JOIN issue_work_state tw ON tw.issue_id = t.id
       WHERE d.project_id = ${projectId} AND d.kind = 'blocks'
         AND (d.valid_until IS NULL OR d.valid_until > now())
         AND (d.from_issue_id IN (${idList(ids)}) OR d.to_issue_id IN (${idList(ids)}))`),
  );
}

interface CriteriaRaw {
  issue_id: string;
  verdict: 'pass' | 'short' | 'fail' | 'skipped' | null;
  bc_code: string | null;
}

async function criteriaOf(ids: readonly string[]): Promise<CriteriaRaw[]> {
  if (ids.length === 0) return [];
  return rowsOf<CriteriaRaw>(
    await db.execute(sql`
      SELECT c.issue_id, v.verdict, rc.code AS bc_code
        FROM issue_criteria c
        LEFT JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id
        LEFT JOIN LATERAL (
          SELECT cv.verdict FROM criterion_verdicts cv
           WHERE cv.criterion_id = c.id
           ORDER BY cv.created_at DESC, cv.id DESC
           LIMIT 1
        ) v ON true
       WHERE c.issue_id IN (${idList(ids)}) AND c.retired_at IS NULL
       ORDER BY c.issue_id, c.position, c.n`),
  );
}

interface RequirementRaw {
  id: string;
  req_seq: number;
  title: string;
  current_revision: number | null;
}

async function requirementsOf(ids: readonly string[]): Promise<Map<string, RequirementRaw>> {
  if (ids.length === 0) return new Map();
  const rows = rowsOf<RequirementRaw>(
    await db.execute(
      sql`SELECT id, req_seq, title, current_revision FROM requirements WHERE id IN (${idList(ids)})`,
    ),
  );
  return new Map(rows.map((r) => [r.id, r]));
}

interface ModuleRaw {
  issue_id: string | null;
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  is_primary: boolean | null;
}

/** Each issue's module: its primary module label, else its first; the path runs from the root. */
async function modulesOf(projectId: string, ids: readonly string[]) {
  const out = new Map<string, { id: string; path: string; name: string }>();
  if (ids.length === 0) return out;
  const [all, links] = await Promise.all([
    db.execute(sql`
      SELECT NULL::uuid AS issue_id, id, name, slug, parent_id, NULL::boolean AS is_primary
        FROM labels WHERE project_id = ${projectId} AND kind = 'module'`),
    db.execute(sql`
      SELECT il.issue_id, l.id, l.name, l.slug, l.parent_id, il.is_primary
        FROM issue_labels il JOIN labels l ON l.id = il.label_id
       WHERE il.issue_id IN (${idList(ids)}) AND l.kind = 'module'
       ORDER BY il.is_primary DESC, l.name`),
  ]);
  const byId = new Map(rowsOf<ModuleRaw>(all).map((m) => [m.id, m]));
  const pathOf = (m: ModuleRaw) => {
    const parts = [m.slug];
    const seen = new Set([m.id]);
    let at = m.parent_id ? byId.get(m.parent_id) : undefined;
    while (at && !seen.has(at.id)) {
      parts.unshift(at.slug);
      seen.add(at.id);
      at = at.parent_id ? byId.get(at.parent_id) : undefined;
    }
    return parts.join('/');
  };
  for (const l of rowsOf<ModuleRaw>(links)) {
    if (!l.issue_id || out.has(l.issue_id)) continue;
    out.set(l.issue_id, { id: l.id, path: pathOf(l), name: l.name });
  }
  return out;
}

async function feedbackOf(ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = rowsOf<{ routed_issue_id: string; fb_seq: number }>(
    await db.execute(sql`
      SELECT routed_issue_id, fb_seq FROM feedback
       WHERE routed_issue_id IN (${idList(ids)}) ORDER BY fb_seq`),
  );
  for (const r of rows)
    out.set(r.routed_issue_id, [...(out.get(r.routed_issue_id) ?? []), `FB-${r.fb_seq}`]);
  return out;
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
  const role = access?.role ?? null;
  const person = people.get(viewer.userId)?.kind !== 'agent';
  return { userId: viewer.userId, canWrite: person && (role === 'admin' || role === 'member') };
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
    edgesOf(projectId, ids),
    criteriaOf(ids),
    modulesOf(projectId, ids),
    feedbackOf(ids),
    approvalRequired(projectId),
    viewerOf(viewer, projectId),
  ]);
  const [requirements, people, designHolds] = await Promise.all([
    requirementsOf([...new Set(raws.map((r) => r.requirement_id).filter((x): x is string => !!x))]),
    peopleOf(raws.flatMap((r) => [r.assignee_id, r.created_by_id])),
    designHoldsOf([...ids, ...edges.map((e) => e.from_id)]),
  ]);
  const designHold = (id: string) => {
    const holds = designHolds.get(id);
    return holds ? designHoldPhrase(holds) : null;
  };
  const key = (seq: number) => formatIssueRef(prefix, seq);
  const edge = (
    id: string,
    seq: number,
    title: string,
    status: KernelIssueStatus,
    merged: boolean,
    step: WorkStep | null,
  ): StandingEdge => ({
    id,
    key: key(seq),
    title,
    status,
    merged,
    step,
    designHold: designHold(id),
  });

  const inputs = raws.map((r): [IssueRowRaw, IssueStandingInput] => {
    const mine = criteria.filter((c) => c.issue_id === r.id);
    const req = r.requirement_id ? requirements.get(r.requirement_id) : undefined;
    const ownerId = r.assignee_id ?? r.created_by_id;
    const owner = ownerId ? people.get(ownerId) : undefined;
    return [
      r,
      {
        status: r.status,
        designHold: designHold(r.id),
        waitingKind: r.waiting_kind,
        merged: r.merged_at !== null,
        step: r.step,
        stepStartedAt: r.step_started_at ? new Date(r.step_started_at) : null,
        lease: leaseOf(r.lease, now),
        inFlight: r.moving,
        owesAnswer: r.owes_answer,
        blockedBy: edges
          .filter((e) => e.to_id === r.id)
          .map((e) =>
            edge(e.from_id, e.from_seq, e.from_title, e.from_status, e.from_merged, e.from_step),
          ),
        blocks: edges
          .filter((e) => e.from_id === r.id)
          .map((e) => edge(e.to_id, e.to_seq, e.to_title, e.to_status, e.to_merged, e.to_step)),
        criteria: {
          total: mine.length,
          passing: mine.filter((c) => c.verdict === 'pass' || c.verdict === 'short').length,
          failing: mine.filter((c) => c.verdict === 'fail').length,
          skipped: mine.filter((c) => c.verdict === 'skipped').length,
        },
        requirement: req
          ? {
              key: `REQ-${req.req_seq}`,
              title: req.title,
              criteria: [
                ...new Set(mine.map((c) => c.bc_code).filter((c): c is string => !!c)),
              ].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))),
              plannedRevision: r.planned_revision,
              currentRevision: req.current_revision,
              changedSincePlan:
                r.planned_revision !== null &&
                req.current_revision !== null &&
                r.planned_revision < req.current_revision,
            }
          : null,
        module: modules.get(r.id) ?? null,
        feedback: feedback.get(r.id) ?? [],
        branch: r.branch,
        headSha: r.head_sha,
        owner: ownerId
          ? { id: ownerId, name: owner?.name ?? null, kind: owner?.kind ?? 'human' }
          : null,
        touchedAt: latest(r.updated_at, r.ws_updated_at, r.last_activity),
        releaseApproval,
        viewer: who,
        now,
      },
    ];
  });
  const groups = new Map<string, IssueAttentionGroup>(
    inputs.map(([r, input]) => [r.id, deriveIssueStanding(input).attentionGroup]),
  );
  const waves = wavesOf([
    ...inputs.map(([r, input]) => ({
      id: r.id,
      status: r.status,
      designHeld: designHolds.has(r.id),
      blockedBy: input.blockedBy.map((b) => b.id),
    })),
    // a blocker outside the page still decides its dependents' wave by its status
    ...edges
      .filter((e) => !groups.has(e.from_id))
      .map((e) => ({
        id: e.from_id,
        status: e.from_status,
        designHeld: designHolds.has(e.from_id),
        blockedBy: [] as string[],
      })),
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
  const [[row], releaseApproval] = await Promise.all([
    standingRows(projectId, raws, viewer, now),
    approvalRequired(projectId),
  ]);
  if (!row) return null;
  return { ...row, steps: raw.steps ?? [], releaseApproval };
}
