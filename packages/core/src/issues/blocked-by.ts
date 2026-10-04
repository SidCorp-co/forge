import { TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import { ISSUE_STATUS_LABELS, type WorkStep } from '@forge/contracts/issue-vocabulary';
import type { IssueTakeRefusalCode } from '@forge/contracts/issues';
import { type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { isRefusal, RefusalError } from '../lib/refusal.js';
import { BLOCKER_SETTLED_STATUSES, DISPATCH_GATING_KIND } from './dependency-effects.js';
import {
  type DesignHold,
  designHeldSql,
  designHoldPhrase,
  designHoldsOf,
} from './design-delivery.js';
import {
  assertDispatchGatesForIssue,
  assertDispatchGatesForSeqs,
  isDispatchGateError,
} from './dispatch-gates.js';

const DROPPED: IssueStatus = 'dropped';

const settledList = sql.join(
  BLOCKER_SETTLED_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

// cm:guard the one settle predicate (REQ-2 BC-11, FB-57): a blocker holds its dependents until it
// reaches BLOCKER_SETTLED_STATUSES and every design revision it delivers is approved. A dropped
// blocker holds nothing: a drop expires its edges (drop-cascade.ts), and an edge drawn from an issue
// already dropped is read the same way. The admissible set, every claim door and the issue reads
// (through blockingEdgesIn) ask this, so none can release what another holds.
export function blockerUnsettledSql(blocker: SQL): SQL {
  return sql`(${blocker}.status <> ${DROPPED} AND (${blocker}.status NOT IN (${settledList}) OR ${designHeldSql(sql`${blocker}.id`)}))`;
}

const liveBlockingEdges = (where: SQL, joins: SQL = sql``) => sql`
  FROM issue_dependencies d
  JOIN issues b ON b.id = d.from_issue_id
  ${joins}
  WHERE d.kind = ${DISPATCH_GATING_KIND}
    AND (d.valid_until IS NULL OR d.valid_until > now())
    AND ${where}`;

// cm:why correlated on the project as well as the endpoint: issue_dependencies carries only the
// composite indexes (project_id, from_issue_id) and (project_id, to_issue_id), and an endpoint-only
// filter degrades to a sequential scan of every edge; an edge never crosses projects, so the
// correlation narrows nothing a claim could take.
export function blockedByUnsettledSql(args: { issueId: SQL; projectId: SQL | string }): SQL {
  return sql`EXISTS (SELECT 1 ${liveBlockingEdges(
    sql`d.project_id = ${args.projectId} AND d.to_issue_id = ${args.issueId} AND ${blockerUnsettledSql(sql`b`)}`,
  )})`;
}

/** One live `blocks` edge, both ends as they stand, and whether its blocker still holds. */
export interface BlockingEdge {
  edgeId: string;
  fromId: string;
  toId: string;
  fromSeq: number;
  toSeq: number;
  fromTitle: string;
  toTitle: string;
  fromStatus: IssueStatus;
  toStatus: IssueStatus;
  fromMerged: boolean;
  toMerged: boolean;
  fromStep: WorkStep | null;
  toStep: WorkStep | null;
  /** `blockerUnsettledSql` over the blocker: the edge holds `to` back. */
  holds: boolean;
  /** The design revisions each end delivers that are not approved yet. */
  fromDesign: DesignHold[];
  toDesign: DesignHold[];
}

/**
 * The input of the blocked-by fact: every live `blocks` edge touching these issues. The issue
 * standing read and the dependency read call it with the database, and every take gate with its own
 * transaction, so all of them judge the same rows by the one predicate.
 */
export async function blockingEdgesIn(
  executor: Pick<Tx, 'execute'>,
  projectId: string,
  issueIds: readonly string[],
): Promise<BlockingEdge[]> {
  if (issueIds.length === 0) return [];
  const ids = sql.join(
    [...new Set(issueIds)].map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await executor.execute(sql`
    SELECT d.id AS edge_id, d.from_issue_id AS from_id, d.to_issue_id AS to_id,
           b.iss_seq AS from_seq, t.iss_seq AS to_seq, b.title AS from_title, t.title AS to_title,
           b.status AS from_status, t.status AS to_status,
           b.merged_at IS NOT NULL AS from_merged, t.merged_at IS NOT NULL AS to_merged,
           bw.step AS from_step, tw.step AS to_step,
           ${blockerUnsettledSql(sql`b`)} AS holds
    ${liveBlockingEdges(
      sql`d.project_id = ${projectId} AND (d.from_issue_id IN (${ids}) OR d.to_issue_id IN (${ids}))`,
      sql`JOIN issues t ON t.id = d.to_issue_id
          LEFT JOIN issue_work_state bw ON bw.issue_id = b.id
          LEFT JOIN issue_work_state tw ON tw.issue_id = t.id`,
    )}
    ORDER BY b.iss_seq, t.iss_seq`)) as unknown as Array<Record<string, unknown>>;
  const designs = await designHoldsOf(
    executor,
    rows.flatMap((r) => [String(r.from_id), String(r.to_id)]),
  );
  return rows.map((r) => ({
    edgeId: String(r.edge_id),
    fromId: String(r.from_id),
    toId: String(r.to_id),
    fromSeq: Number(r.from_seq),
    toSeq: Number(r.to_seq),
    fromTitle: String(r.from_title),
    toTitle: String(r.to_title),
    fromStatus: r.from_status as IssueStatus,
    toStatus: r.to_status as IssueStatus,
    fromMerged: r.from_merged === true,
    toMerged: r.to_merged === true,
    fromStep: (r.from_step as WorkStep | null) ?? null,
    toStep: (r.to_step as WorkStep | null) ?? null,
    holds: r.holds === true,
    fromDesign: designs.get(String(r.from_id)) ?? [],
    toDesign: designs.get(String(r.to_id)) ?? [],
  }));
}

interface UnsettledBlocker {
  issueId: string;
  issueKey: string;
  status: IssueStatus;
  design: string | null;
}

async function unsettledBlockersOf(
  executor: Pick<Tx, 'execute'>,
  issue: { id: string; projectId: string; prefix: string | null },
): Promise<UnsettledBlocker[]> {
  const edges = await blockingEdgesIn(executor, issue.projectId, [issue.id]);
  return edges
    .filter((e) => e.toId === issue.id && e.holds)
    .map((e) => ({
      issueId: e.fromId,
      issueKey: formatIssueRef(issue.prefix, e.fromSeq),
      status: e.fromStatus,
      design: e.fromDesign.length > 0 ? designHoldPhrase(e.fromDesign) : null,
    }));
}

function whyUnsettled(b: UnsettledBlocker): string {
  const settled = BLOCKER_SETTLED_STATUSES.includes(b.status);
  const status = `${b.issueKey} is at \`${b.status}\` (${ISSUE_STATUS_LABELS[b.status]})`;
  if (!settled && b.design) return `${status}, and its ${b.design}`;
  if (!settled) return status;
  return `${b.issueKey} is at \`${b.status}\`, and its ${b.design ?? 'design revision is not approved'}`;
}

interface BlockedIssue {
  issueKey: string;
  blockers: UnsettledBlocker[];
}

function heldPhrase(held: BlockedIssue): string {
  const { issueKey, blockers } = held;
  const edges =
    blockers.length === 1
      ? 'a live `blocks` edge holds'
      : `${blockers.length} live \`blocks\` edges hold`;
  return `${issueKey}: ${edges} it, ${blockers.map(whyUnsettled).join('; ')}`;
}

const BLOCKED_REMEDY =
  `A blocker releases its dependents once it reaches ${BLOCKER_SETTLED_STATUSES.map((s) => `\`${s}\``).join(' or ')} ` +
  'with every design revision it delivers approved. Move the blocker there, or retract the edge on ' +
  'the record (`validUntil` in the past) where it no longer holds; no claim, lease, run or status ' +
  "move takes a blocked issue, a person's included.";

/** Every held issue a door would take, refused by name in one envelope. */
function issueBlocked(held: BlockedIssue[], door: string): RefusalError {
  return new RefusalError(
    held.map((h) => ({
      code: 'ISSUE_BLOCKED' satisfies IssueTakeRefusalCode,
      path: '',
      detail: `${door} is refused. ${heldPhrase(h)}. ${BLOCKED_REMEDY}`,
    })),
    'ISSUE_BLOCKED',
  );
}

const isTakeable = (status: IssueStatus) => TAKEABLE_STATUSES.includes(status);

type TakenIssue = {
  id: string;
  projectId: string;
  prefix: string | null;
  status: IssueStatus;
  issueKey: string;
};

async function blockedOf(
  executor: Pick<Tx, 'execute'>,
  issue: TakenIssue,
): Promise<BlockedIssue | null> {
  if (!isTakeable(issue.status)) return null;
  const blockers = await unsettledBlockersOf(executor, issue);
  return blockers.length > 0 ? { issueKey: issue.issueKey, blockers } : null;
}

const takenRow = (row: Record<string, unknown>): TakenIssue => ({
  id: String(row.id),
  projectId: String(row.project_id),
  prefix: (row.issue_prefix as string | null) ?? null,
  status: row.status as IssueStatus,
  issueKey: formatIssueRef((row.issue_prefix as string | null) ?? null, Number(row.iss_seq)),
});

async function readTaken(executor: Pick<Tx, 'execute'>, where: SQL) {
  const rows = (await executor.execute(sql`
    SELECT i.id, i.project_id, i.status, i.iss_seq, p.issue_prefix
      FROM issues i JOIN projects p ON p.id = i.project_id
     WHERE ${where}
     ORDER BY i.iss_seq
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map(takenRow);
}

export async function refuseBlockedTake(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
  door: string,
): Promise<void> {
  const [issue] = await readTaken(executor, sql`i.id = ${issueId}`);
  const held = issue ? await blockedOf(executor, issue) : null;
  if (held) throw issueBlocked([held], door);
}

// cm:guard a door that hands out work and does not already ask the dispatch gates asks everything the
// admissible set holds an unstarted issue out for: an unsettled blocks edge, then the design and
// contract-wait gates (issues/dispatch-gates.ts), each refused by its own name
export async function refuseHeldTake(
  executor: Pick<Tx, 'execute' | 'select'>,
  issueId: string,
  door: string,
): Promise<void> {
  const [issue] = await readTaken(executor, sql`i.id = ${issueId}`);
  if (!issue || !isTakeable(issue.status)) return;
  const held = await blockedOf(executor, issue);
  if (held) throw issueBlocked([held], door);
  await assertDispatchGatesForIssue(issue.projectId, issue.id, executor);
}

async function refuseBlockedTakeForSeqs(
  executor: Pick<Tx, 'execute'>,
  projectId: string,
  seqs: readonly number[],
  door: string,
): Promise<void> {
  if (seqs.length === 0) return;
  const list = sql.join(
    seqs.map((s) => sql`${s}`),
    sql`, `,
  );
  const issues = await readTaken(
    executor,
    sql`i.project_id = ${projectId} AND i.iss_seq IN (${list})`,
  );
  const held: BlockedIssue[] = [];
  for (const issue of issues) {
    const blocked = await blockedOf(executor, issue);
    if (blocked) held.push(blocked);
  }
  if (held.length > 0) throw issueBlocked(held, door);
}

export async function refuseHeldTakeForSeqs(
  projectId: string,
  seqs: readonly number[],
): Promise<void> {
  await refuseBlockedTakeForSeqs(db, projectId, seqs, 'a run session over these issues');
  await assertDispatchGatesForSeqs(projectId, seqs);
}

/** A refused take in the envelope: a blocked issue as thrown, a dispatch gate's refusal named. */
export function heldTakeRefusal(err: unknown): RefusalError | null {
  if (
    isRefusal(err, 'ISSUE_BLOCKED') ||
    isRefusal(err, 'WORKFLOW_DESIGN_NOT_APPROVED') ||
    isRefusal(err, 'CONTRACT_WAIT_UNSETTLED')
  ) {
    return err;
  }
  if (isDispatchGateError(err)) {
    return new RefusalError([{ code: err.code, path: '', detail: err.message }], err.code);
  }
  return null;
}
