/**
 * The rows the issue standing derives from (`standing-read.ts`), and its scope counts, each read for
 * every project a person's read asks before its quiet point (`db/read-memo.ts:rowsPerId`).
 */

import { ISSUE_TERMINAL_STATUSES, type IssueStatus } from '@forge/contracts/issue-machine';
import type { IssueStandingScope } from '@forge/contracts/issue-standing';
import type { WorkStep } from '@forge/contracts/issue-vocabulary';
import type { AnswerHold, AnswerResume } from '@forge/contracts/questions';
import type { WrittenLang } from '@forge/contracts/written-lang';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf, uuidArray } from '../db/raw-sql.js';
import { memoizedPerId, onePerProject, rowsPerId, rowsPerProject } from '../db/read-memo.js';
import { scopeHeldSql } from '../db/schema-issue-designs.js';
import type { WorkStepEntry } from '../db/schema-issue-work-state.js';
import { blockerUnsettledSql, holdingEdgesSql } from './blocked-by.js';
import { contractWaitUnsettledSql } from './contract-waits.js';
import { designOnlyMarkSql, designReturnedUnderSql } from './design-delivery.js';
import { landedSql, mergeSinceLastReopenSql } from './host-landing.js';
import { issueRunLiveSql, issueWorkMovingSql } from './issue-lease.js';
import { leaseByMasterSql } from './master-lease.js';
import { owedMarkSql } from './owed-merges.js';
import { parkSinceSql } from './park-since.js';
import { patternReviewPendingSql } from './patterns.js';
import { answeredSinceSql, designUnapprovedSql, holdsOpenHumanQuestion } from './ports.js';

const DONE_SQL = sql`(${sql.join(
  ISSUE_TERMINAL_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;

export interface IssueRowRaw {
  id: string;
  iss_seq: number;
  title: string;
  written_lang: WrittenLang | null;
  status: IssueStatus;
  waiting_kind: string | null;
  landed: boolean;
  landed_since_reopen: boolean;
  release_noted: boolean;
  priority: string;
  category: string | null;
  complexity: string | null;
  assignee_id: string | null;
  created_by_id: string | null;
  by_agent: boolean;
  /** Filed by an account of the retired steward (`steward_accounts`). */
  by_steward: boolean;
  /** Filed by an agent account (`users.kind = 'agent'`), whichever box it was filed from. */
  by_agent_account: boolean;
  /** The person who owns the box it was filed from; null where none filed it. */
  box_owner_id: string | null;
  requirement_id: string | null;
  planned_revision: number | null;
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
  design_only: boolean;
  ws_updated_at: string | null;
  last_activity: string | null;
  moving: boolean;
  run_live: boolean;
  lease_by_master: boolean;
  owes_answer: boolean;
  holds_dependents: boolean;
  park_entry: { reason: string | null; agency: string; actorType: string } | null;
  answered_park: { hold: AnswerHold | null; resume: AnswerResume | null } | null;
  design_returned: { flow: string; revision: number } | null;
  design_unapproved: boolean;
  contract_unsettled: boolean;
  pattern_pending: boolean;
  scope_held: boolean;
  owed_mark: { number: number; commit: string } | null;
  status_since: string;
  project_id: string;
}

function scopeSql(scope: IssueStandingScope): SQL {
  if (scope === 'open') return sql`AND i.status NOT IN ${DONE_SQL}`;
  if (scope === 'closed') return sql`AND i.status IN ${DONE_SQL}`;
  return sql``;
}

/** Each issue `where` names, with every fact its standing reads, newest write first. */
async function rowsWhere<R = IssueRowRaw>(
  where: SQL,
  /** A `WITH` the read's `where` names, and a column of it each row carries as `held_for`. */
  held?: { with: SQL; heldFor: SQL },
): Promise<R[]> {
  return rowsOf<R>(
    await db.execute(sql`
      ${held?.with ?? sql``}
      SELECT ${held ? sql`${held.heldFor} AS held_for, ` : sql``}i.id, i.project_id, i.iss_seq, i.title, i.written_lang, i.status, i.waiting_kind,
             ${landedSql(sql`i`)} AS landed,
             (${landedSql(sql`i`)} AND ${mergeSinceLastReopenSql(sql`i`)}) AS landed_since_reopen,
             (i.release_notes IS NOT NULL AND i.release_notes <> 'null'::jsonb) AS release_noted,
             i.priority, i.category, i.complexity,
             i.assignee_id, i.created_by_id, i.requirement_id, i.planned_revision,
             (i.created_by_device_id IS NOT NULL OR EXISTS (
               SELECT 1 FROM users u WHERE u.id = i.created_by_id AND u.kind = 'agent')) AS by_agent,
             EXISTS (SELECT 1 FROM users u WHERE u.id = i.created_by_id AND u.kind = 'agent') AS by_agent_account,
             EXISTS (SELECT 1 FROM steward_accounts sa WHERE sa.user_id = i.created_by_id) AS by_steward,
             (SELECT d.owner_id FROM devices d WHERE d.id = i.created_by_device_id) AS box_owner_id,
             CASE WHEN btrim(coalesce(i.plan, '')) <> '' THEN 'written' END AS plan,
             i.created_at, i.updated_at,
             w.step, w.step_started_at, w.steps, w.lease, w.branch, w.head_sha, w.left_status,
             w.updated_at AS ws_updated_at, ${designOnlyMarkSql(sql`i`)} AS design_only,
             (SELECT max(a.created_at) FROM activity_log a WHERE a.issue_id = i.id) AS last_activity,
             coalesce((SELECT max(kt.created_at) FROM kernel_transitions kt
                        WHERE kt.entity = 'issue' AND kt.entity_id = i.id AND kt.to_status = i.status),
                      i.created_at) AS status_since,
             ${holdsOpenHumanQuestion(sql`i.id`)} AS owes_answer,
             ${blockerUnsettledSql(sql`i`)} AS holds_dependents,
             ${designUnapprovedSql(sql`i.id`)} AS design_unapproved,
             CASE WHEN i.status = 'on_hold' THEN (
               SELECT jsonb_build_object('reason', kt.reason, 'agency', kt.actor_agency, 'actorType', kt.actor_type)
                 FROM kernel_transitions kt
                WHERE kt.entity = 'issue' AND kt.entity_id = i.id AND kt.to_status = 'on_hold'
                ORDER BY kt.created_at DESC LIMIT 1) END AS park_entry,
             CASE WHEN i.status = 'needs_info' THEN ${answeredSinceSql(
               sql`i.id`,
               parkSinceSql(sql`i.id`),
             )} END AS answered_park,
             ${designReturnedUnderSql(sql`i.id`)} AS design_returned,
             ${contractWaitUnsettledSql(sql`i.id`)} AS contract_unsettled,
             ${patternReviewPendingSql(sql`i.id`)} AS pattern_pending,
             ${scopeHeldSql(sql`i.id`)} AS scope_held,
             ${owedMarkSql(sql`i`)} AS owed_mark,
             ${issueWorkMovingSql({
               issueId: sql`i.id`,
               projectId: sql`i.project_id`,
               issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
             })} AS moving,
             ${issueRunLiveSql({ projectId: sql`i.project_id`, issueKey: sql`'ISS-' || i.iss_seq` })} AS run_live,
             ${leaseByMasterSql(sql`i`, sql`w`)} AS lease_by_master
        FROM issues i
        LEFT JOIN issue_work_state w ON w.issue_id = i.id
       WHERE i.archived_at IS NULL AND ${where}
       ORDER BY i.updated_at DESC, i.iss_seq DESC`),
  );
}

/** How far a read follows live blockers outside the rows it was asked for; past it a blocker reads unread. */
export const BLOCKER_DEPTH = 4;

const inScope = (scope: IssueStandingScope, status: IssueStatus) =>
  scope === 'all' || ISSUE_TERMINAL_STATUSES.includes(status) === (scope === 'closed');

/** A project's page of one scope, and the rows of the blockers outside it that hold it. */
export interface PageAndHolders {
  page: IssueRowRaw[];
  /**
   * Every issue outside the page whose live `blocks` edge holds one of its rows, and those holding
   * them in turn, {@link BLOCKER_DEPTH} edges deep: the rows the standing follows them to
   * (`standing-read.ts:standingRows`).
   */
  holders: IssueRowRaw[];
}

/**
 * A project's newest `limit` issues in `scope`, every project asked with it read in one statement
 * (ISS-1070 r6): each project's newest are ranked inside it, as its own read ranks them. The same
 * statement reads the blockers outside the page that hold it: the standing followed each of them in
 * a read of its own, two waves later, so forge-dev's open list sent its blockers' edges, modules and
 * carried feedback twice (ISS-1070 r19).
 */
export async function issueRowsAndHolders(
  projectId: string,
  scope: IssueStandingScope,
  limit: number,
): Promise<PageAndHolders> {
  const rows = await rowsPerProject(
    `issueRows:${scope}:${limit}`,
    projectId,
    (ids) =>
      rowsWhere(sql`i.id IN (
        WITH RECURSIVE page AS (
          SELECT top.id, top.project_id FROM unnest(${uuidArray(ids)}) AS p(id)
          CROSS JOIN LATERAL (
            SELECT i.id, i.project_id FROM issues i
             WHERE i.project_id = p.id AND i.archived_at IS NULL ${scopeSql(scope)}
             ORDER BY i.updated_at DESC, i.iss_seq DESC
             LIMIT ${limit}) top
        ), held(id, project_id, hop) AS (
          SELECT d.from_issue_id, d.project_id, 1 FROM page pg
            ${holdingEdgesSql(sql`d.project_id = pg.project_id AND d.to_issue_id = pg.id`)}
          UNION
          SELECT d.from_issue_id, d.project_id, h.hop + 1 FROM held h
            ${holdingEdgesSql(sql`d.project_id = h.project_id AND d.to_issue_id = h.id`)}
           WHERE h.hop < ${BLOCKER_DEPTH}
        )
        SELECT id FROM page UNION SELECT id FROM held)`),
    (r) => r.project_id,
  );
  // the page is the newest `limit` rows in scope, so a holder in scope ranks after every one of them
  const page: IssueRowRaw[] = [];
  const holders: IssueRowRaw[] = [];
  for (const r of rows) {
    if (page.length < limit && inScope(scope, r.status)) page.push(r);
    else holders.push(r);
  }
  return { page, holders };
}

/** A project's newest `limit` issues in `scope` ({@link issueRowsAndHolders}'s page). */
export async function issueRowsIn(
  projectId: string,
  scope: IssueStandingScope,
  limit: number,
): Promise<IssueRowRaw[]> {
  return (await issueRowsAndHolders(projectId, scope, limit)).page;
}

/** The issues of `projectId` among `ids`, newest write first; every project's asks are one read. */
export async function issueRowsById(
  projectId: string,
  ids: readonly string[],
): Promise<IssueRowRaw[]> {
  const rows = await rowsPerId(
    'issueRowsById',
    ids,
    // the ids bound as one array: one statement text however many, so its plan is not made again
    // for every count of ids (ISS-1070 r9: 20 to 35 ms planning it, three times a read)
    (some) => rowsWhere(sql`i.id = ANY(${uuidArray(some)})`),
    (r) => r.id,
  );
  return rows.filter((r) => r.project_id === projectId).sort(newestWriteFirst);
}

/** The order the issue reads answer rows in: newest write first. */
export const newestWriteFirst = (a: IssueRowRaw, b: IssueRowRaw) =>
  new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime() || b.iss_seq - a.iss_seq;

/**
 * The rows of `ids` in `projectId`, newest write first as {@link issueRowsById} answers them, and in
 * the same statement the rows outside them of the blockers that hold them, {@link BLOCKER_DEPTH}
 * edges deep: the standing follows those to rows already read (ISS-1070 r19). Every project's asks
 * are one read; each id's holders are its own.
 */
export async function issueRowsAndHoldersById(
  projectId: string,
  ids: readonly string[],
): Promise<{ rows: IssueRowRaw[]; holders: IssueRowRaw[] }> {
  type Held = IssueRowRaw & { held_for: string[] };
  const byId = await memoizedPerId('issueRowsHeldById', ids, async (some) => {
    const roots = uuidArray(some);
    const read = await rowsWhere<Held>(
      sql`(i.id = ANY(${roots}) OR i.id IN (SELECT id FROM held))`,
      {
        with: sql`WITH RECURSIVE held(root, id, project_id, hop) AS (
          SELECT x.id, d.from_issue_id, d.project_id, 1 FROM issues x
            ${holdingEdgesSql(sql`d.project_id = x.project_id AND d.to_issue_id = x.id`)}
           WHERE x.id = ANY(${roots})
          UNION
          SELECT h.root, d.from_issue_id, d.project_id, h.hop + 1 FROM held h
            ${holdingEdgesSql(sql`d.project_id = h.project_id AND d.to_issue_id = h.id`)}
           WHERE h.hop < ${BLOCKER_DEPTH}
        )`,
        heldFor: sql`ARRAY(SELECT DISTINCT h.root::text FROM held h WHERE h.id = i.id)`,
      },
    );
    return new Map(
      some.map((id) => [
        id,
        {
          row: read.find((r) => r.id === id),
          holders: read.filter((r) => r.held_for.includes(id) && r.id !== id),
        },
      ]),
    );
  });
  const rows: IssueRowRaw[] = [];
  const holders = new Map<string, IssueRowRaw>();
  for (const { row, holders: of } of byId.values()) {
    if (row) rows.push(row);
    for (const h of of) holders.set(h.id, h);
  }
  const mine = (r: IssueRowRaw) => r.project_id === projectId;
  const asked = new Set(rows.map((r) => r.id));
  return {
    rows: rows.filter(mine).sort(newestWriteFirst),
    holders: [...holders.values()].filter((h) => mine(h) && !asked.has(h.id)),
  };
}

/** The issue `issSeq` names in `projectId`, alone. */
export const issueRowOf = (projectId: string, issSeq: number) =>
  rowsWhere(sql`i.project_id = ${projectId} AND i.iss_seq = ${issSeq}`);

/** How many of a project's issues are open and closed; every project's asks are one read. */
export async function scopeCounts(projectId: string): Promise<{ open: number; closed: number }> {
  const held = await onePerProject('issueScopeCounts', projectId, async (ids) => {
    const rows = rowsOf<{ project_id: string; open: number; closed: number }>(
      await db.execute(sql`
        SELECT project_id, count(*) FILTER (WHERE status NOT IN ${DONE_SQL})::int AS open,
               count(*) FILTER (WHERE status IN ${DONE_SQL})::int AS closed
          FROM issues WHERE project_id = ANY(${uuidArray(ids)}) AND archived_at IS NULL
         GROUP BY project_id`),
    );
    return new Map(rows.map((r) => [r.project_id, { open: r.open, closed: r.closed }]));
  });
  return held ?? { open: 0, closed: 0 };
}
