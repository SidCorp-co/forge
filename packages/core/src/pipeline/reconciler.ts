import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { postIssueNotice } from '../comments/index.js';
import type { IssueStatus } from '../db/schema.js';
import { transitionIssueStatus } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { holdsOpenHumanQuestion, personOwesAnAnswer } from '../questions/issue-coupling.js';
import { wakeMastersForProject } from '../ws/master-wake.js';
import {
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_INFLIGHT_STATUSES,
  AUTONOMOUS_JOB_TYPE,
} from './autonomous-mode.js';
import { checkAutonomousRescueCap, recordAutonomousRescue } from './autonomous-rescue-cap.js';
import {
  AgentMintedSinceSelected,
  mintReconcilerActor,
  reconcilerActorFor,
} from './reconciler-actor.js';
import {
  buildWedgeResetBody,
  readWedgeLease,
  wedgeLeaseHoldsTheIssue,
  wedgeLeaseUnderLock,
} from './wedge-lease.js';

const STALE_OUTBOX_INTERVAL = '5 minutes';
const STUCK_ISSUE_INTERVAL = '60 seconds';
const STUCK_ISSUE_LIMIT = 100;

const WEDGE_GRACE = '10 minutes';
const WEDGE_RESET_LIMIT = 50;
const WEDGE_SCAN_PAGE = 200;

export async function runReconcilerOnce(): Promise<{
  rescued: number;
  stale: number;
  autonomousReset: number;
}> {
  let rescued = 0;
  let stale = 0;
  let autonomousReset = 0;

  const stuck = await db.execute<{
    id: string;
    project_id: string;
    status: string;
    created_by: string | null;
    reopen_count: number;
  }>(sql`
    SELECT i.id, i.project_id, i.status, i.reopen_count, p.created_by
    FROM issues i
    INNER JOIN projects p ON p.id = i.project_id
    WHERE i.status = ${AUTONOMOUS_ENTRY_STATUS}
      AND i.merged_at IS NULL
      AND i.updated_at < now() - interval '${sql.raw(STUCK_ISSUE_INTERVAL)}'
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.issue_id = i.id
          AND j.status IN ('queued','dispatched','running')
      )
    LIMIT ${STUCK_ISSUE_LIMIT}
  `);

  for (const row of stuck) {
    try {
      const cap = await checkAutonomousRescueCap({
        projectId: row.project_id,
        issueId: row.id,
        status: row.status as IssueStatus,
        reopenCount: row.reopen_count,
      });
      if (cap.capped) continue;
      const autonomousRunId: string | null = cap.runId;

      const { boxes } = await wakeMastersForProject({
        projectId: row.project_id,
        issueId: row.id,
        status: row.status as IssueStatus,
      });

      if (boxes === 0) continue;

      if (autonomousRunId) await recordAutonomousRescue(autonomousRunId);

      rescued++;
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'pipeline.reconciler.enqueued_missing',
          level: 'warning',
          data: { issueId: row.id, status: row.status },
        });
      }
    } catch (err) {
      logger.error({ err, issueId: row.id, status: row.status }, 'reconciler: rescue failed');
    }
  }

  try {
    const staleRows = await db.execute<{ count: string | number }>(sql`
      SELECT COUNT(*)::text AS count
      FROM pipeline_outbox
      WHERE processed_at IS NULL
        AND created_at < now() - interval '${sql.raw(STALE_OUTBOX_INTERVAL)}'
    `);
    const first = staleRows[0];
    const n = first ? Number(first.count) : 0;
    if (n > 0) {
      stale = n;
      logger.warn({ stale: n }, 'reconciler: outbox has stale unprocessed rows');
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'pipeline.outbox.stale_unprocessed',
          level: 'warning',
          data: { staleCount: n },
        });
      }
    }
  } catch (err) {
    logger.error({ err }, 'reconciler: stale-outbox probe failed');
  }

  try {
    autonomousReset = await resetAutonomousWedgesOnce();
  } catch (err) {
    logger.error({ err }, 'reconciler: autonomous wedge pass failed');
  }

  return { rescued, stale, autonomousReset };
}

/** Committed between the wedge read and the reset's row lock: a question for a person, a lease. */
class AskedSinceSelected extends Error {}
class LeaseRenewedSinceSelected extends Error {}

type WedgeCandidate = {
  id: string;
  project_id: string;
  status: string;
  reopen_count: number;
  lease: unknown;
};

/** Candidates are read in id order a page at a time, so rows a live lease holds cannot fill every
 *  slot of {@link WEDGE_RESET_LIMIT} and keep a wedge that really is one from being reached. */
async function selectWedgeCandidates(after: string | null): Promise<WedgeCandidate[]> {
  const inflightList = sql.join(
    AUTONOMOUS_INFLIGHT_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const past = after === null ? sql`` : sql`AND i.id > ${after}::uuid`;
  return (await db.execute<WedgeCandidate>(sql`
    SELECT i.id, i.project_id, i.status, i.reopen_count,
           (SELECT w.lease FROM issue_work_state w WHERE w.issue_id = i.id) AS lease
    FROM issues i
    CROSS JOIN LATERAL (
      SELECT j.type, j.status
      FROM jobs j
      WHERE j.issue_id = i.id
      ORDER BY j.created_at DESC
      LIMIT 1
    ) lj
    WHERE i.status IN (${inflightList})
      AND i.updated_at < now() - interval '${sql.raw(WEDGE_GRACE)}'
      AND lj.type = ${AUTONOMOUS_JOB_TYPE}
      AND NOT ${holdsOpenHumanQuestion(sql`i.id`)}
      AND NOT EXISTS (
        SELECT 1 FROM jobs j2
        WHERE j2.issue_id = i.id
          AND j2.status IN ('queued', 'dispatched', 'running')
      )
      AND (
        (
          lj.status = 'done'
          AND EXISTS (
            SELECT 1 FROM pipeline_runs r
            WHERE r.issue_id = i.id AND r.kind = 'issue' AND r.status = 'running'
          )
        )
        OR (
          i.merged_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM pipeline_runs r2
            WHERE r2.issue_id = i.id
              AND r2.kind = 'issue'
              AND r2.status IN ('running', 'paused')
          )
        )
      )
      ${past}
    ORDER BY i.id
    LIMIT ${WEDGE_SCAN_PAGE}
  `)) as unknown as WedgeCandidate[];
}

export async function resetAutonomousWedgesOnce(): Promise<number> {
  if (AUTONOMOUS_INFLIGHT_STATUSES.length === 0) return 0;
  let reset = 0;
  let after: string | null = null;

  while (reset < WEDGE_RESET_LIMIT) {
    const page = await selectWedgeCandidates(after);
    for (const row of page) {
      if (reset >= WEDGE_RESET_LIMIT) break;
      if (await resetOneWedge(row)) reset++;
    }
    const last = page.at(-1);
    if (page.length < WEDGE_SCAN_PAGE || !last) break;
    after = last.id;
  }

  return reset;
}

async function resetOneWedge(row: WedgeCandidate): Promise<boolean> {
  if (wedgeLeaseHoldsTheIssue(readWedgeLease(row.lease, new Date()))) {
    logger.info(
      { issueId: row.id, status: row.status },
      'reconciler: a run holds a live lease on this issue, so the wedge net leaves it',
    );
    return false;
  }
  try {
    const { capped, runId } = await checkAutonomousRescueCap({
      projectId: row.project_id,
      issueId: row.id,
      status: row.status as IssueStatus,
      reopenCount: row.reopen_count,
    });
    if (capped) return false;

    const actor = await reconcilerActorFor(row.project_id);
    await transitionIssueStatus(
      {
        id: row.id,
        projectId: row.project_id,
        status: row.status as IssueStatus,
        reopenCount: row.reopen_count,
      },
      AUTONOMOUS_ENTRY_STATUS,
      actor,
      {
        reason: 'reconciler_autonomous_wedge_reset',
        recovery: true,
        beforeStatusWrite: async (tx) => {
          if (await personOwesAnAnswer(tx, row.id)) throw new AskedSinceSelected();
          const reading = readWedgeLease(await wedgeLeaseUnderLock(tx, row.id), new Date());
          if (wedgeLeaseHoldsTheIssue(reading)) throw new LeaseRenewedSinceSelected();
          await mintReconcilerActor(tx, row.project_id, actor);
          await postIssueNotice(
            {
              issueId: row.id,
              authorId: actor.id,
              body: buildWedgeResetBody({
                from: row.status,
                to: AUTONOMOUS_ENTRY_STATUS,
                grace: WEDGE_GRACE,
                reading,
              }),
            },
            tx,
          );
        },
      },
    );

    if (runId) await recordAutonomousRescue(runId);

    logger.warn(
      { issueId: row.id, from: row.status, to: AUTONOMOUS_ENTRY_STATUS },
      'reconciler: reset autonomous driver wedge to the entry status',
    );
    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: 'pipeline.reconciler.autonomous_wedge_reset',
        level: 'warning',
        data: { issueId: row.id, from: row.status },
      });
    }
    return true;
  } catch (err) {
    if (err instanceof AskedSinceSelected) {
      logger.info(
        { issueId: row.id },
        'reconciler: a person was asked since the wedge read, so it stays',
      );
      return false;
    }
    if (err instanceof LeaseRenewedSinceSelected) {
      logger.info(
        { issueId: row.id },
        'reconciler: a lease was renewed since the wedge read, so it stays',
      );
      return false;
    }
    if (err instanceof AgentMintedSinceSelected) {
      logger.info(
        { issueId: row.id, projectId: row.project_id },
        'reconciler: the project gained an agent account since the wedge read, so the next pass resets it',
      );
      return false;
    }
    logger.error(
      { err, issueId: row.id, status: row.status },
      'reconciler: autonomous wedge reset failed',
    );
    return false;
  }
}
