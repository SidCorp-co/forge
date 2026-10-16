// ISS-1421 — Releasing means a release batch run is carrying the issue to production right now, so
// it is not a status an issue may wait in. Every recovery before this one starts from a batch run;
// this pass starts from the ROW: an issue at Releasing that no running or paused run claims has
// nothing carrying it, and is settled out loud. Where production's verified deployment carries the
// issue's landing commit it is closed by a release record; otherwise it goes back to the gate.

import { sql } from 'drizzle-orm';
import { postSystemComment } from '../comments/system-write.js';
import { db, type Tx } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { transitionIssueStatus } from '../issues/apply-transition.js';
import { statusLabel } from '../issues/status-sets.js';
import { logger } from '../logger.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { recordPerformedRelease } from './recorded.js';
import {
  type ProductionFinding,
  type ProductionReading,
  readProductionFinding,
} from './releasing-settle-reading.js';

/** At most this many rows a tick, oldest first; the rest are read on later ticks. */
export const RELEASING_SETTLE_PAGE = 50;

/** The run statuses that are still carrying their roster. */
const LIVE_RUN_STATUSES = ['running', 'paused'] as const;

export interface ReleasingSettleResult {
  /** Rows taken off Releasing this pass. */
  settled: number;
  /** Of those, the ones a release record then closed. */
  closed: number;
  /** Rows this pass could not move, each logged with why. */
  failed: number;
}

interface StrandedRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  reopen_count: number;
  release_batch_run_id: string | null;
  run_status: string | null;
  run_exists: boolean;
  landing: string | null;
  created_by: string;
}

/** The commit an issue landed at, as the sweep judges carriage against it. */
const LANDING = sql`NULLIF(btrim(COALESCE(i.merged_commit_sha, i.merged_claimed_commit, '')), '')`;

async function strandedRows(): Promise<StrandedRow[]> {
  const live = sql.join(
    LIVE_RUN_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  return (await db.execute<StrandedRow>(sql`
    SELECT i.id, i.project_id, i.reopen_count, i.release_batch_run_id,
           r.status AS run_status, (r.id IS NOT NULL) AS run_exists,
           ${LANDING} AS landing,
           p.created_by
    FROM issues i
    JOIN projects p ON p.id = i.project_id
    LEFT JOIN pipeline_runs r ON r.id = i.release_batch_run_id
    WHERE i.status = 'releasing'
      AND i.archived_at IS NULL
      AND (r.id IS NULL OR r.status NOT IN (${live}))
    ORDER BY i.updated_at ASC, i.id ASC
    LIMIT ${RELEASING_SETTLE_PAGE}
  `)) as unknown as StrandedRow[];
}

/** Why nothing is carrying this row, in the words its comment opens with. */
export function strandedCause(
  row: Pick<StrandedRow, 'release_batch_run_id' | 'run_status' | 'run_exists'>,
): string {
  if (row.release_batch_run_id === null) {
    return 'No release run claims this issue, so nothing was releasing it';
  }
  if (!row.run_exists) {
    return `It names release run ${row.release_batch_run_id}, which no longer exists, so nothing was releasing it`;
  }
  return `Release run ${row.release_batch_run_id} claimed it and ended ${row.run_status}, so nothing was releasing it`;
}

const GATE = statusLabel(RELEASE_GATE_STATUS);

function startAgain(projectId: string): string {
  return (
    `It is back at ${GATE}. If its code has already shipped, record that with ` +
    `POST /api/projects/${projectId}/release-records naming the commit production serves, which ` +
    'closes it; otherwise start a release with the Release button on this page or at the release gate.'
  );
}

/** What the sweep found on production, and what follows for the issue, as its comment says it. */
export function findingSentence(finding: ProductionFinding, projectId: string): string {
  switch (finding.kind) {
    case 'carried':
      return `Production's verified live deployment serves \`${finding.serving}\`, which carries this issue's landing commit \`${finding.landing}\`, so its code has shipped: a release record closes it now.`;
    case 'not-carried':
      return `Production's verified live deployment serves \`${finding.serving}\`, which does not carry this issue's landing commit \`${finding.landing}\`, so its code has not shipped. ${startAgain(projectId)}`;
    case 'unverified':
      return `This project's live deployment declares no verify probe, so nothing can read what production serves, and the sweep never closes an issue on a deployment nobody read. ${startAgain(projectId)}`;
    case 'no-landing':
      return `This issue carries no landing commit, so nothing can say whether production has its code. Mark it merged naming the commit it landed at. ${startAgain(projectId)}`;
    case 'unread':
      return `What production serves could not be read: ${finding.why}. ${startAgain(projectId)}`;
  }
}

/** Raised inside the move's transaction when the row is no longer the one this pass read. */
class SettleFenceLost extends Error {}

/** The row still stands as read, its claim is still dead; then the claim goes with the move. */
async function fenceAndRelease(tx: Tx, row: StrandedRow): Promise<void> {
  type Now = { status: IssueStatus; claim: string | null; live: boolean; landing: string | null };
  const [now] = (await tx.execute<Now>(sql`
    SELECT i.status, i.release_batch_run_id AS claim, ${LANDING} AS landing,
           EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.id = i.release_batch_run_id
                   AND r.status IN ('running', 'paused')) AS live
    FROM issues i WHERE i.id = ${row.id} FOR UPDATE
  `)) as unknown as Now[];
  if (
    now?.status !== 'releasing' ||
    now.claim !== row.release_batch_run_id ||
    now.live ||
    now.landing !== row.landing
  ) {
    throw new SettleFenceLost(`issue ${row.id} moved while the releasing sweep read it`);
  }
  await tx.execute(sql`
    UPDATE issues SET release_batch_run_id = NULL, updated_at = now() WHERE id = ${row.id}
  `);
}

function sweepActor(row: StrandedRow): TransitionActor {
  return { type: 'user', id: row.created_by, agency: 'agent' };
}

/** Back to the gate, the dead claim cleared and the comment posted, in one transaction. */
async function returnToGate(row: StrandedRow, body: string, reason: string): Promise<void> {
  await transitionIssueStatus(
    {
      id: row.id,
      projectId: row.project_id,
      status: 'releasing',
      reopenCount: row.reopen_count,
    },
    RELEASE_GATE_STATUS,
    sweepActor(row),
    {
      // The gate's entry records are not re-read: an unearned one would hold the row at Releasing
      // for good, under a door nothing else may pass (ISS-1421 decision record).
      skip: true,
      viaReleasePath: true,
      reason,
      beforeStatusWrite: async (tx) => {
        await fenceAndRelease(tx, row);
        await postSystemComment({ issueId: row.id, authorId: row.created_by, body }, tx);
      },
    },
  );
}

async function closeByRecord(
  row: StrandedRow,
  finding: Extract<ProductionFinding, { kind: 'carried' }>,
  cause: string,
): Promise<boolean> {
  const account =
    `Recorded by Forge's releasing sweep (ISS-1421). ${cause}; production's verified live ` +
    `deployment serves ${finding.serving}, which carries this issue's landing commit ${finding.landing}.`;
  try {
    const result = await recordPerformedRelease({
      projectId: row.project_id,
      issueIds: [row.id],
      commit: finding.servingWhole,
      account,
      userId: row.created_by,
      actor: sweepActor(row),
      beforeClose: (tx, issueId) => landingStill(tx, issueId, finding.landing),
    });
    if (result.closed.includes(row.id)) return true;
    const failed = result.failed.find((f) => f.id === row.id)?.reason ?? 'it named no reason';
    await sayRecordRefused(row, failed);
    return false;
  } catch (err) {
    await sayRecordRefused(row, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** The close is judged on the landing production was read as carrying; a landing marked since is
 *  not, and the issue stays at the gate saying so. */
export async function landingStill(tx: Tx, issueId: string, judged: string): Promise<void> {
  const [now] = (await tx.execute<{ landing: string | null }>(sql`
    SELECT ${LANDING} AS landing FROM issues i WHERE i.id = ${issueId} FOR UPDATE
  `)) as unknown as Array<{ landing: string | null }>;
  if (now?.landing !== judged) {
    throw new Error(
      `its landing commit is now ${now?.landing ?? 'unmarked'}, not ${judged}, which production was read as carrying`,
    );
  }
}

async function sayRecordRefused(row: StrandedRow, why: string): Promise<void> {
  await postSystemComment({
    issueId: row.id,
    authorId: row.created_by,
    body:
      `The release record that would close this issue was refused: ${why}. ` +
      `It stays at ${GATE}. ${startAgain(row.project_id)}`,
  });
}

async function settleOne(
  row: StrandedRow,
  read: (projectId: string) => Promise<ProductionReading>,
): Promise<'closed' | 'returned'> {
  const cause = strandedCause(row);
  const finding: ProductionFinding = row.landing
    ? await (await read(row.project_id)).forLanding(row.landing)
    : { kind: 'no-landing' };
  const body = [
    `**Releasing, with nothing releasing it.** ${cause}.`,
    `Releasing means a release batch is carrying an issue to production right now, and none was, so Forge's releasing sweep has settled it.`,
    findingSentence(finding, row.project_id),
  ].join('\n\n');
  await returnToGate(row, body, `releasing sweep: ${cause}`);
  if (finding.kind !== 'carried') return 'returned';
  return (await closeByRecord(row, finding, cause)) ? 'closed' : 'returned';
}

export interface ReleasingSettleDeps {
  /** What production serves for a project, read once a pass; the tests' seam onto the network. */
  production?: (projectId: string) => Promise<ProductionReading>;
}

/** Settle every row at Releasing that no live release run is carrying. */
export async function settleStrandedReleasing(
  deps: ReleasingSettleDeps = {},
): Promise<ReleasingSettleResult> {
  const rows = await strandedRows();
  const result: ReleasingSettleResult = { settled: 0, closed: 0, failed: 0 };
  if (rows.length === 0) return result;

  const readings = new Map<string, Promise<ProductionReading>>();
  const read = (projectId: string) => {
    const kept = readings.get(projectId);
    if (kept) return kept;
    const fresh = (deps.production ?? readProductionFinding)(projectId);
    readings.set(projectId, fresh);
    return fresh;
  };

  for (const row of rows) {
    try {
      const outcome = await settleOne(row, read);
      result.settled++;
      if (outcome === 'closed') result.closed++;
    } catch (err) {
      if (err instanceof SettleFenceLost) continue;
      result.failed++;
      logger.error(
        { err, issueId: row.id, projectId: row.project_id },
        'releasing-settle: could not take an issue off Releasing',
      );
    }
  }
  if (result.settled > 0 || result.failed > 0) {
    logger.warn(result, 'releasing-settle: issues at Releasing with nothing releasing them');
  }
  return result;
}

const SETTLE_QUEUE = 'release-batch-releasing-settle';
let registered = false;

/** Run the pass once a minute on its own queue, beside the other release recoveries. */
export async function registerReleasingSettle(): Promise<void> {
  if (registered) return;
  const { boss } = await import('../queue/boss.js');
  await boss.createQueue(SETTLE_QUEUE);
  await boss.work(SETTLE_QUEUE, async () => {
    await settleStrandedReleasing();
  });
  await boss.schedule(SETTLE_QUEUE, '* * * * *');
  registered = true;
}

export function resetReleasingSettleForTest(): void {
  registered = false;
}
