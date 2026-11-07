/**
 * Gathers the facts `standing.ts` derives from, for a project's issues at once: the work state and
 * lease, whether a box is moving it, open human questions, live `blocks` edges, criteria verdicts,
 * the automatic release's hold on a row at its gate,
 * the requirement and business criteria it traces to, its primary module, the feedback routed to
 * it and its last activity. One query per fact over the whole page, never one per row.
 */

import type {
  IssueLeaseView,
  IssueStandingDetail,
  IssueStandingList,
  IssueStandingRow,
  IssueStandingScope,
  IssueWithheld,
} from '@forge/contracts/issue-standing';
import type { ReleaseHoldView } from '@forge/contracts/releases';
import { changedSincePlan } from '@forge/contracts/requirements';
import type { MasterServing } from '@forge/contracts/steward';
import { verdictEarns } from '@forge/contracts/verdict-identity';
import type { VerifiedJudge } from '@forge/contracts/verified-rule';
import { db } from '../db/client.js';
import { memoizedPerId } from '../db/read-memo.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { holderNames } from '../permissions/index.js';
import type { BlockingEdge } from './blocked-by.js';
import { deliveryHeads } from './delivery-head.js';
import { designHoldPhrase } from './design-delivery.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { loadIssuePark } from './park-view.js';
import { safeHydratePipelineHealthForIssues } from './pipeline-health.js';
import {
  approvalRequired,
  changedTracedOf,
  masterServingOf,
  readJudge,
  releaseHoldsOf,
} from './ports.js';
import { classifyLease } from './session-claim.js';
import { deriveIssueStanding, type IssueStandingInput, type StandingEdge } from './standing.js';
import { issueBlockerOf } from './standing-blocker.js';
import { criteriaPerIssue, edgesPerIssue } from './standing-facts-memo.js';
import {
  type criteriaOf,
  feedbackOf,
  modulesOf,
  type RequirementRaw,
  requirementsOf,
  tracedCodesOf,
} from './standing-facts-read.js';
import { settledGroups } from './standing-groups.js';
import { ownerIdOf } from './standing-owner.js';
import {
  type IssueRowRaw,
  issueRowOf,
  issueRowsById,
  issueRowsIn,
  scopeCounts,
} from './standing-rows.js';
import { wavesOf } from './standing-waves.js';
import { withheldOf } from './standing-withheld-read.js';
import { stepFactsOf } from './step-facts-read.js';
import { stepOutcomesOf } from './step-outcomes.js';

/** The most rows one read answers; the list says so when a scope holds more. */
export const STANDING_LIMIT = 500;

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

type Facts = {
  key: (seq: number) => string;
  edges: BlockingEdge[];
  criteria: Awaited<ReturnType<typeof criteriaOf>>;
  requirements: Awaited<ReturnType<typeof requirementsOf>>;
  changedTraced: Map<string, { code: string; revision: number }[]>;
  modules: Awaited<ReturnType<typeof modulesOf>>;
  feedback: Awaited<ReturnType<typeof feedbackOf>>;
  people: Awaited<ReturnType<typeof peopleOf>>;
  releaseApproval: boolean;
  writers: string[];
  admins: string[];
  withheld: Map<string, IssueWithheld>;
  releaseHolds: Map<string, ReleaseHoldView>;
  master: MasterServing;
  judge: VerifiedJudge | null;
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
  changed: readonly { code: string; revision: number }[],
): IssueStandingInput['requirement'] {
  if (!req) return null;
  return {
    key: `REQ-${req.req_seq}`,
    project: req.project,
    title: req.title,
    ...tracedCodesOf(mine),
    plannedRevision: r.planned_revision,
    currentRevision: req.current_revision,
    changedSincePlan: changedSincePlan({
      plan: r.plan,
      plannedRevision: r.planned_revision,
      currentRevision: req.current_revision,
      changedTraced: changed,
    }),
  };
}

function standingInputOf(r: IssueRowRaw, f: Facts): IssueStandingInput {
  const mine = f.criteria.filter((c) => c.issue_id === r.id);
  const ownerId = ownerIdOf({
    assignee: r.assignee_id,
    creator: r.created_by_id,
    creatorIsSteward: r.by_steward,
    creatorIsAgent: r.by_agent_account,
    boxOwner: r.box_owner_id,
  });
  const owner = ownerId ? f.people.get(ownerId) : undefined;
  return {
    status: r.status,
    leftStatus: r.left_status,
    designOnly: r.design_only === true,
    holdsDependents: r.holds_dependents,
    waitingKind: r.waiting_kind,
    merged: r.landed,
    mergedSinceReopen: r.landed_since_reopen,
    step: r.step,
    stepStartedAt: r.step_started_at ? new Date(r.step_started_at) : null,
    lease: leaseOf(r.lease, f.now),
    inFlight: r.moving,
    runLive: r.run_live,
    owesAnswer: r.owes_answer,
    answered: r.answered_park
      ? { hold: r.answered_park.hold ?? null, resume: r.answered_park.resume ?? null }
      : null,
    park: r.park_entry
      ? {
          reason: r.park_entry.reason,
          byAgent: r.park_entry.agency === 'agent' || r.park_entry.actorType !== 'user',
        }
      : null,
    designReturned: r.design_returned,
    blockedBy: f.edges.filter((e) => e.toId === r.id).map((e) => edgeEnd(e, 'from', f.key)),
    blocks: f.edges.filter((e) => e.fromId === r.id).map((e) => edgeEnd(e, 'to', f.key)),
    criteria: {
      total: mine.length,
      met: mine.filter((c) => c.stands && c.counts && verdictEarns(c.verdict)).length,
      failing: mine.filter((c) => c.verdict === 'fail').length,
      skipped: mine.filter((c) => c.verdict === 'skipped').length,
    },
    requirement: requirementRef(
      r,
      r.requirement_id ? f.requirements.get(r.requirement_id) : undefined,
      mine,
      f.changedTraced.get(r.id) ?? [],
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
    releaseNoted: r.release_noted,
    releaseHold: f.releaseHolds.get(r.id) ?? null,
    owedMark: r.owed_mark,
    writers: f.writers,
    admins: f.admins,
    withheld: f.withheld.get(r.id) ?? null,
    statusSince: new Date(r.status_since),
    master: f.master,
    judge: f.judge,
    now: f.now,
  };
}

/** How far a read follows live blockers outside the rows it was asked for; past it a blocker reads unread. */
const BLOCKER_DEPTH = 4;

async function standingRows(
  projectId: string,
  raws: readonly IssueRowRaw[],
  now: Date,
  depth = 0,
): Promise<IssueStandingRow[]> {
  if (raws.length === 0) return [];
  const ids = raws.map((r) => r.id);
  const [
    prefix,
    edges,
    criteria,
    modules,
    feedback,
    releaseApproval,
    withheld,
    writers,
    admins,
    master,
    judge,
    releaseHolds,
  ] = await Promise.all([
    activeIssuePrefix(projectId),
    edgesPerIssue(projectId, ids),
    criteriaPerIssue(projectId, ids),
    memoizedPerId(`modules:${projectId}`, ids, (some) => modulesOf(projectId, some)),
    feedbackOf(ids),
    approvalRequired(projectId),
    withheldOf(projectId, raws),
    holderNames('project.write', projectId),
    holderNames('project.admin', projectId),
    masterServingOf(projectId),
    readJudge(projectId),
    releaseHoldsOf(raws.filter((r) => r.status === 'awaiting_release').map((r) => r.id)),
  ]);
  const [requirements, people, changedTraced] = await Promise.all([
    requirementsOf(
      raws.map((r) => r.requirement_id).filter((x): x is string => !!x),
      projectId,
    ),
    peopleOf(raws.flatMap((r) => [r.assignee_id, r.created_by_id, r.box_owner_id])),
    changedTracedOf(db, ids),
  ]);
  const key = (seq: number) => formatIssueRef(prefix, seq);
  const facts: Facts = {
    key,
    edges,
    criteria,
    requirements,
    changedTraced,
    modules,
    feedback,
    people,
    releaseApproval,
    writers,
    admins,
    withheld,
    releaseHolds,
    master,
    judge,
    now,
  };
  // on a change-request project the issue's head is its request's, not a run's worklog capture
  const heads = await deliveryHeads(projectId, ids);
  const inputs = raws.map((raw): [IssueRowRaw, IssueStandingInput] => {
    const head = heads?.get(raw.id.toLowerCase());
    const r = head ? { ...raw, branch: head.branch, head_sha: head.sha } : raw;
    return [r, standingInputOf(r, facts)];
  });
  const groups = await settledGroups(
    inputs.map(([r, input]) => [r.id, input] as const),
    depth < BLOCKER_DEPTH
      ? async (outside) => {
          const raws = await issueRowsById(projectId, outside);
          const read = await standingRows(projectId, raws, now, depth + 1);
          return new Map(read.map((r) => [r.id, r.standing.attentionGroup]));
        }
      : null,
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
    writtenLang: r.written_lang,
    status: r.status,
    priority: r.priority,
    category: r.category,
    complexity: r.complexity,
    assigneeId: r.assignee_id,
    createdById: r.created_by_id,
    byAgent: r.by_agent,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    standing: deriveIssueStanding(input, groups, waves.get(r.id) ?? null),
  }));
}

/** The list a project's Issues screen reads: one scope, newest write first, at most `limit` rows. */
export async function listIssueStanding(
  projectId: string,
  scope: IssueStandingScope,
  now: Date = new Date(),
  limit: number = STANDING_LIMIT,
): Promise<IssueStandingList> {
  const [raws, counts, releaseApproval] = await Promise.all([
    issueRowsIn(projectId, scope, limit),
    scopeCounts(projectId),
    approvalRequired(projectId),
  ]);
  const issues = await standingRows(projectId, raws, now);
  return {
    issues,
    counts: {
      open: counts.open,
      closed: counts.closed,
      all: counts.open + counts.closed,
      blocked: issues.filter((i) => i.standing.blockedBy.length > 0).length,
      blocking: issues.filter((i) => i.standing.blocks.length > 0).length,
    },
    returned: issues.length,
    limit,
    releaseApproval,
  };
}

/**
 * Each of `ids`' own standing wait, keyed by id, for a read model that names what one of its issues
 * holds it on (a requirement whose issue is parked) rather than saying it again in words of its own.
 */
export async function issueWaitsOf(
  projectId: string,
  ids: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, Pick<IssueStandingRow, 'key' | 'standing'>>> {
  if (ids.length === 0) return new Map();
  const rows = await standingRows(projectId, await issueRowsById(projectId, ids), now);
  return new Map(rows.map((r) => [r.id, { key: r.key, standing: r.standing }]));
}

/** One issue's standing with its step log, for the peek and the full page; null when absent. */
export async function readIssueStanding(
  projectId: string,
  issSeq: number,
  now: Date = new Date(),
): Promise<IssueStandingDetail | null> {
  const raws = await issueRowOf(projectId, issSeq);
  const raw = raws[0];
  if (!raw) return null;
  const [[row], releaseApproval, health, park, steps] = await Promise.all([
    standingRows(projectId, raws, now),
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
