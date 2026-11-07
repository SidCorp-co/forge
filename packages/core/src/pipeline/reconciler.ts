import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issueRunDeclaredSql, issueWorkInFlightSql } from '../issues/index.js';
import { traceStep } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';
import { countOverdueDeliveries, emitEvent } from '../outbox/index.js';
import { AUTONOMOUS_ENTRY_STATUS } from './autonomous-mode.js';
import { checkAutonomousRescueCap } from './autonomous-rescue-cap.js';
import { holdsOpenHumanQuestion, postIssueNoticeOnce, wakeMastersForProject } from './ports.js';
import { mintReconcilerActor, reconcilerActorFor } from './reconciler-actor.js';
import {
  RESCUE_DELIVERY_LIMIT,
  recordDeliveredRescue,
  rescuesNotDue,
} from './rescue-wake-ledger.js';
import { type LandedWork, landedWorkStands } from './wedge-landed.js';
import {
  buildWedgeLeftLandedBody,
  buildWedgeLeftUnheldBody,
  readWedgeLease,
  wedgeLeaseHoldsTheIssue,
  wedgeLeftLandedMarker,
  wedgeLeftUnheldMarker,
} from './wedge-lease.js';
import { inProgressSinceSql } from './wedge-owed.js';

const STALE_OUTBOX_MS = 5 * 60_000;
const STUCK_ISSUE_INTERVAL = '60 seconds';
const STUCK_ISSUE_LIMIT = 100;

const WEDGE_GRACE = '10 minutes';
/** Findings one pass tells; a finding already told for its basis is passed over and not counted. */
const WEDGE_TELL_LIMIT = 50;
const WEDGE_SCAN_PAGE = 200;

/** The status a wedge stands at. The net reads it and never moves it (issue-delivery `rule-wedge`). */
const WEDGE_STATUS: IssueStatus = 'in_progress';

type RescueCandidate = {
  id: string;
  project_id: string;
  status: string;
  created_by: string | null;
  reopen_count: number;
  changed_at: string;
};

/**
 * Issues at the entry status whose wake may have been lost: unchanged past the interval, with no
 * job, run or lease working them and no run declared over them, no decision since their last
 * change, and no rescue due later. A box holding the issue lost no wake.
 */
export async function selectRescueCandidates(
  notDue: string,
  exec: Pick<Tx, 'execute'> = db,
): Promise<RescueCandidate[]> {
  return (await exec.execute<RescueCandidate>(sql`
    SELECT i.id, i.project_id, i.status, i.reopen_count, p.created_by,
           i.updated_at::text AS changed_at
    FROM issues i
    INNER JOIN projects p ON p.id = i.project_id
    WHERE i.status = ${AUTONOMOUS_ENTRY_STATUS}
      AND i.updated_at < now() - interval '${sql.raw(STUCK_ISSUE_INTERVAL)}'
      AND NOT ${issueWorkInFlightSql({
        issueId: sql`i.id`,
        projectId: sql`i.project_id`,
        issueKey: sql`'ISS-' || i.iss_seq`,
      })}
      AND NOT ${issueRunDeclaredSql({
        projectId: sql`i.project_id`,
        issueKey: sql`'ISS-' || i.iss_seq`,
      })}
      AND NOT EXISTS (
        SELECT 1 FROM comments c
        WHERE c.issue_id = i.id
          AND c.intent = 'decision'
          AND c.created_at >= i.updated_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset(${notDue}::jsonb) AS w(id uuid, at text)
        WHERE w.id = i.id AND w.at::timestamptz = i.updated_at
      )
    LIMIT ${STUCK_ISSUE_LIMIT}
  `)) as unknown as RescueCandidate[];
}

export async function runReconcilerOnce(): Promise<{
  rescued: number;
  stale: number;
  /** Wedges this pass told on their issue and woke the master for: it moves none of them. */
  wedgesTold: number;
}> {
  let rescued = 0;
  let stale = 0;
  let wedgesTold = 0;

  // An issue is rescued only when a wake for it may have been lost: never once a decision recorded
  // on it post-dates its last change (its master has read it as it stands and held it), and a
  // rescue that reached a box is redelivered on the ledger's backoff, not every minute.
  const notDue = await rescuesNotDue(AUTONOMOUS_ENTRY_STATUS, Date.now());
  const stuck = await selectRescueCandidates(notDue);

  for (const row of stuck) {
    try {
      const cap = await checkAutonomousRescueCap({
        projectId: row.project_id,
        issueId: row.id,
        status: row.status as IssueStatus,
        reopenCount: row.reopen_count,
      });
      if (cap.capped) continue;

      const { boxes } = await wakeMastersForProject({
        projectId: row.project_id,
        issueId: row.id,
        status: row.status as IssueStatus,
      });

      if (boxes === 0) continue;

      if (recordDeliveredRescue(row.id, row.changed_at, Date.now())) {
        logger.warn(
          { issueId: row.id, status: row.status, rescues: RESCUE_DELIVERY_LIMIT },
          'reconciler: the masters were woken for this issue as many times as a lost wake is owed, and none dispatched it or recorded a decision; it is not rescued again until it changes',
        );
        traceStep({
          category: 'pipeline.reconciler.rescue_exhausted',
          level: 'warning',
          data: { issueId: row.id, status: row.status, rescues: RESCUE_DELIVERY_LIMIT },
        });
      }
      rescued++;
      traceStep({
        category: 'pipeline.reconciler.enqueued_missing',
        level: 'warning',
        data: { issueId: row.id, status: row.status },
      });
    } catch (err) {
      logger.error({ err, issueId: row.id, status: row.status }, 'reconciler: rescue failed');
    }
  }

  try {
    const n = await countOverdueDeliveries(STALE_OUTBOX_MS);
    if (n > 0) {
      stale = n;
      logger.warn({ stale: n }, 'reconciler: outbox deliveries are overdue');
      traceStep({
        category: 'pipeline.outbox.overdue',
        level: 'warning',
        data: { staleCount: n },
      });
    }
  } catch (err) {
    logger.error({ err }, 'reconciler: stale-outbox probe failed');
  }

  try {
    wedgesTold = await tellAutonomousWedgesOnce();
  } catch (err) {
    logger.error({ err }, 'reconciler: autonomous wedge pass failed');
  }

  return { rescued, stale, wedgesTold };
}

type WedgeCandidate = {
  id: string;
  project_id: string;
  status: string;
  lease: unknown;
  /** When it entered `in_progress` (`wedge-owed.ts:inProgressSinceSql`): what an unheld notice is told once per. */
  since: Date | string;
};

/**
 * Candidates are issues at `in_progress` that nothing holds: no live job, pipeline run or run
 * session lease (issue-delivery `rule-wedge`). Read in id order a page at a time, so rows a live
 * work-state lease holds, or rows already told, cannot fill every slot of {@link WEDGE_TELL_LIMIT}.
 * Only `in_progress` is read: an `on_hold` row is a declared hold, and no sweep reads it.
 */
async function selectWedgeCandidates(after: string | null): Promise<WedgeCandidate[]> {
  const past = after === null ? sql`` : sql`AND i.id > ${after}::uuid`;
  return (await db.execute<WedgeCandidate>(sql`
    SELECT i.id, i.project_id, i.status,
           (SELECT w.lease FROM issue_work_state w WHERE w.issue_id = i.id) AS lease,
           ${inProgressSinceSql(sql`i`)} AS since
    FROM issues i
    WHERE i.status = ${WEDGE_STATUS}
      AND i.updated_at < now() - interval '${sql.raw(WEDGE_GRACE)}'
      AND NOT ${holdsOpenHumanQuestion(sql`i.id`)}
      AND NOT ${issueWorkInFlightSql({
        issueId: sql`i.id`,
        projectId: sql`i.project_id`,
        issueKey: sql`'ISS-' || i.iss_seq`,
      })}
      ${past}
    ORDER BY i.id
    LIMIT ${WEDGE_SCAN_PAGE}
  `)) as unknown as WedgeCandidate[];
}

/**
 * The wedge net detects and wakes; it never moves a status (ISS-1104, FB-553). A sweep reading "no
 * job, run or live lease for ten minutes" reads a proxy, and acting on it handed held work away
 * (ISS-1063..1066; ISS-1071..1073, whose lapsed lease outlived a landing still in flight). Each
 * finding is told once per basis on the issue, and the project's master is woken to decide.
 */
async function tellAutonomousWedgesOnce(): Promise<number> {
  let told = 0;
  let after: string | null = null;

  while (told < WEDGE_TELL_LIMIT) {
    const page = await selectWedgeCandidates(after);
    for (const row of page) {
      if (told >= WEDGE_TELL_LIMIT) break;
      try {
        if (await tellOneWedge(row)) told++;
      } catch (err) {
        logger.error(
          { err, issueId: row.id, status: row.status },
          'reconciler: telling a wedge failed',
        );
      }
    }
    const last = page.at(-1);
    if (page.length < WEDGE_SCAN_PAGE || !last) break;
    after = last.id;
  }

  return told;
}

/** Whether this pass told the wedge: a live lease, or a finding already told, tells nothing. */
async function tellOneWedge(row: WedgeCandidate): Promise<boolean> {
  if (wedgeLeaseHoldsTheIssue(readWedgeLease(row.lease, new Date()))) {
    logger.info(
      { issueId: row.id, status: row.status },
      'reconciler: a run holds a live lease on this issue, so the wedge net leaves it',
    );
    return false;
  }
  const landed = await landedWorkStands(db, row.id);
  if (landed) return leaveLandedWork(row, landed);
  return leaveUnheldWork(row, new Date(row.since));
}

/** The reconciler's account, minted for the project where it has none; null where the mint lost. */
async function noticeAuthor(projectId: string) {
  const actor = await reconcilerActorFor(projectId);
  const minted = await db.transaction((tx) => mintReconcilerActor(tx, projectId, actor));
  if (!minted) {
    logger.info(
      { projectId },
      'reconciler: the project gained an agent account since the wedge read, so the next pass tells it',
    );
    return null;
  }
  return actor;
}

/**
 * Landed work nothing holds stays at `in_progress` (ISS-564): no status moves by itself, so the
 * agent owing it moves it to `awaiting_release` (REQ-45 BC-1, BC-7). Once per mark, one notice says
 * so on the issue and one `issue.landedWorkLeft` wakes the project's master, which the sweep then
 * names the move to (`masters/owed.ts`); both commit together, and a later pass over the same mark
 * writes neither. A new mark (a round landed again after a reopen) is told anew.
 */
async function leaveLandedWork(row: WedgeCandidate, landed: LandedWork): Promise<boolean> {
  const actor = await noticeAuthor(row.project_id);
  if (!actor) return false;
  const body = buildWedgeLeftLandedBody({
    grace: WEDGE_GRACE,
    reading: readWedgeLease(row.lease, new Date()),
    landed,
  });
  const told = await db.transaction(async (tx) => {
    const posted = await postIssueNoticeOnce(
      { issueId: row.id, authorId: actor.id, body, marker: wedgeLeftLandedMarker(landed) },
      tx,
    );
    if (posted === null) return false;
    await emitEvent(tx, 'issue.landedWorkLeft', {
      issueId: row.id,
      projectId: row.project_id,
      mergedAt: landed.mergedAt.toISOString(),
      commit: landed.commit,
      landing: landed.landing,
    });
    return true;
  });
  if (!told) return false;
  logger.warn(
    { issueId: row.id, mergedAt: landed.mergedAt, commit: landed.commit },
    'reconciler: left landed work at in_progress and woke its master to move it to awaiting_release',
  );
  traceStep({
    category: 'pipeline.reconciler.autonomous_wedge_left_landed',
    level: 'warning',
    data: { issueId: row.id },
  });
  return true;
}

/**
 * Work that did not land, with nothing holding it, stays at `in_progress` too: a held issue and a
 * dead run read the same from here, so the master decides which it is, never this pass. Once per
 * stretch at `in_progress` one notice says so on the issue, and the project's master is woken and
 * finds it named on its sweep (`wedge-owed.ts:wedgedWorkOwed`). The wake follows the notice's
 * commit: one lost to a crash between them is made good by that sweep naming it on any later pass.
 */
async function leaveUnheldWork(row: WedgeCandidate, since: Date): Promise<boolean> {
  const actor = await noticeAuthor(row.project_id);
  if (!actor) return false;
  const body = buildWedgeLeftUnheldBody({
    grace: WEDGE_GRACE,
    reading: readWedgeLease(row.lease, new Date()),
    since,
  });
  const posted = await postIssueNoticeOnce({
    issueId: row.id,
    authorId: actor.id,
    body,
    marker: wedgeLeftUnheldMarker(since),
  });
  if (posted === null) return false;
  await wakeMastersForProject({
    projectId: row.project_id,
    issueId: row.id,
    status: WEDGE_STATUS,
  });
  logger.warn(
    { issueId: row.id, since },
    'reconciler: left unheld work at in_progress and woke its master to decide on it',
  );
  traceStep({
    category: 'pipeline.reconciler.autonomous_wedge_left_unheld',
    level: 'warning',
    data: { issueId: row.id },
  });
  return true;
}
