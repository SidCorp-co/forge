import { type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { BLOCKER_SETTLED_STATUSES, DISPATCH_GATING_KIND } from './dependency-effects.js';
import { designHeldSql, designHoldPhrase, designHoldsOf } from './design-delivery.js';
import {
  assertDispatchGatesForIssue,
  assertDispatchGatesForSeqs,
  isDispatchGateError,
} from './dispatch-gates.js';
import { ISSUE_STATUS_LABELS, TAKEABLE_STATUSES } from './status-sets.js';

const DROPPED: IssueStatus = 'dropped';

const settledList = sql.join(
  BLOCKER_SETTLED_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

// cm:guard the one settle predicate (REQ-2 BC-11, FB-57): a blocker holds its dependents until it
// reaches BLOCKER_SETTLED_STATUSES and every design revision it delivers is approved. A dropped
// blocker holds nothing: a drop expires its edges (drop-cascade.ts), and an edge drawn from an issue
// already dropped is read the same way, as the issue list reads it (standing.ts:holdsBack). The
// admissible set and every claim door ask this, so none can release what another holds.
export function blockerUnsettledSql(blocker: SQL): SQL {
  return sql`(${blocker}.status <> ${DROPPED} AND (${blocker}.status NOT IN (${settledList}) OR ${designHeldSql(sql`${blocker}.id`)}))`;
}

const liveBlockingEdges = (issueId: SQL | string, projectId: SQL | string) => sql`
  FROM issue_dependencies d
  JOIN issues b ON b.id = d.from_issue_id
  WHERE d.project_id = ${projectId}
    AND d.to_issue_id = ${issueId}
    AND d.kind = ${DISPATCH_GATING_KIND}
    AND (d.valid_until IS NULL OR d.valid_until > now())
    AND ${blockerUnsettledSql(sql`b`)}`;

// cm:why correlated on the project as well as the endpoint: issue_dependencies carries only the
// composite indexes (project_id, from_issue_id) and (project_id, to_issue_id), and an endpoint-only
// filter degrades to a sequential scan of every edge; an edge never crosses projects, so the
// correlation narrows nothing a claim could take.
export function blockedByUnsettledSql(args: { issueId: SQL; projectId: SQL | string }): SQL {
  return sql`EXISTS (SELECT 1 ${liveBlockingEdges(args.issueId, args.projectId)})`;
}

export interface UnsettledBlocker {
  issueId: string;
  issueKey: string;
  status: IssueStatus;
  design: string | null;
}

export async function unsettledBlockersOf(
  executor: Pick<Tx, 'execute'>,
  issue: { id: string; projectId: string },
): Promise<UnsettledBlocker[]> {
  const rows = (await executor.execute(sql`
    SELECT b.id, b.status, b.iss_seq,
           (SELECT bp.issue_prefix FROM projects bp WHERE bp.id = b.project_id) AS issue_prefix
    ${liveBlockingEdges(issue.id, issue.projectId)}
    ORDER BY b.iss_seq
  `)) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const holds = await designHoldsOf(rows.map((r) => String(r.id)));
  return rows.map((r) => {
    const held = holds.get(String(r.id));
    return {
      issueId: String(r.id),
      issueKey: formatIssueRef((r.issue_prefix as string | null) ?? null, Number(r.iss_seq)),
      status: r.status as IssueStatus,
      design: held ? designHoldPhrase(held) : null,
    };
  });
}

function whyUnsettled(b: UnsettledBlocker): string {
  const settled = BLOCKER_SETTLED_STATUSES.includes(b.status);
  const status = `${b.issueKey} is at \`${b.status}\` (${ISSUE_STATUS_LABELS[b.status]})`;
  if (!settled && b.design) return `${status}, and its ${b.design}`;
  if (!settled) return status;
  return `${b.issueKey} is at \`${b.status}\`, and its ${b.design ?? 'design revision is not approved'}`;
}

export interface BlockedIssue {
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

export class IssueBlockedError extends Error {
  readonly code = 'ISSUE_BLOCKED';

  constructor(
    readonly held: BlockedIssue[],
    readonly door: string,
  ) {
    super(
      `ISSUE_BLOCKED: ${door} is refused. ${held.map(heldPhrase).join('. ')}. A blocker releases its ` +
        `dependents once it reaches ${BLOCKER_SETTLED_STATUSES.map((s) => `\`${s}\``).join(' or ')} ` +
        'with every design revision it delivers approved. Move the blocker there, or retract the edge on ' +
        'the record (`validUntil` in the past) where it no longer holds; no claim, lease, run or status ' +
        "move takes a blocked issue, a person's included.",
    );
    this.name = 'IssueBlockedError';
  }

  get blocked() {
    return this.held.map((h) => ({
      issueKey: h.issueKey,
      blockers: h.blockers.map((b) => ({
        issueKey: b.issueKey,
        status: b.status,
        design: b.design,
      })),
    }));
  }
}

export const isTakeable = (status: IssueStatus) => TAKEABLE_STATUSES.includes(status);

type TakenIssue = { id: string; projectId: string; status: IssueStatus; issueKey: string };

async function blockedOf(
  executor: Pick<Tx, 'execute'>,
  issue: TakenIssue,
): Promise<BlockedIssue | null> {
  if (!isTakeable(issue.status)) return null;
  const blockers = await unsettledBlockersOf(executor, issue);
  return blockers.length > 0 ? { issueKey: issue.issueKey, blockers } : null;
}

const takenRow = (row: Record<string, unknown>) => ({
  id: String(row.id),
  projectId: String(row.project_id),
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
  if (held) throw new IssueBlockedError([held], door);
}

// cm:guard a door that hands out work and does not already ask the dispatch gates asks everything the
// admissible set holds an unstarted issue out for: an unsettled blocks edge, then the design and
// contract-wait gates (issues/dispatch-gates.ts), each refused by its own name
export async function refuseHeldTake(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
  door: string,
): Promise<void> {
  const [issue] = await readTaken(executor, sql`i.id = ${issueId}`);
  if (!issue || !isTakeable(issue.status)) return;
  const held = await blockedOf(executor, issue);
  if (held) throw new IssueBlockedError([held], door);
  await assertDispatchGatesForIssue(issue.projectId, issue.id);
}

export async function refuseBlockedTakeForSeqs(
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
  if (held.length > 0) throw new IssueBlockedError(held, door);
}

export async function refuseHeldTakeForSeqs(
  projectId: string,
  seqs: readonly number[],
): Promise<void> {
  await refuseBlockedTakeForSeqs(db, projectId, seqs, 'a run session over these issues');
  await assertDispatchGatesForSeqs(projectId, seqs);
}

export interface HeldTakeRefusal {
  code: string;
  message: string;
  blocked: unknown;
}

export function heldTakeRefusal(err: unknown): HeldTakeRefusal | null {
  if (err instanceof IssueBlockedError || isDispatchGateError(err)) {
    return { code: err.code, message: err.message, blocked: err.blocked };
  }
  return null;
}
