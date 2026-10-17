// ISS-1421 — Releasing means a release batch run is carrying the issue to production right now, so
// it is not a status an issue may wait in. Every recovery before this one starts from a batch run;
// this pass starts from the ROW: an issue at Releasing that no running or paused run claims has
// nothing carrying it, and is settled out loud. Where production's verified deployment carries the
// issue's landing commit it is closed by a release record; otherwise it goes back to the gate.

import { sql } from 'drizzle-orm';
import { forgeAuthorId } from '../comments/forge-author.js';
import { postSystemComment } from '../comments/system-write.js';
import { db, type Tx } from '../db/client.js';
import type { IssueStatus, LandingShape } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { transitionIssueStatus } from '../issues/apply-transition.js';
import { laneOrNull } from '../issues/landing-evidence.js';
import { statusLabel } from '../issues/status-sets.js';
import { logger } from '../logger.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { recordPerformedRelease } from './recorded.js';
import {
  type GateHolds,
  NO_DOORS,
  NO_HOLDS,
  nextAtGateFor,
  type ReleaseDoors,
  type ReleasePath,
  readGateHolds,
  readReleaseDoors,
  readReleasePath,
} from './release-path-words.js';
import {
  type ProductionFinding,
  type ProductionReading,
  readProductionFinding,
} from './releasing-settle-reading.js';
import { releaseRunStopped } from './run-ended-words.js';

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
  project_kind: string;
  declared_lane: string | null;
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
           ${LANDING} AS landing, p.kind AS project_kind,
           i.declared_landing_shape AS declared_lane
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
    return 'The release run that claimed it no longer exists, so nothing was releasing it';
  }
  return `${releaseRunStopped(row.run_status)}, so nothing was releasing it`;
}

const GATE = statusLabel(RELEASE_GATE_STATUS);

/** A production reading, or why the sweep did not take one for this row. */
type SettleFinding = ProductionFinding | { kind: 'outside-git' } | { kind: 'not-read' };

/** What the reader of a row returned to the gate does next, by how its project releases and by
 *  what its page will offer it there. */
function backAtGate(path: ReleasePath, holds: GateHolds, doors: ReleaseDoors): string {
  return [`It is back at ${GATE}.`, ...nextAtGateFor(path, holds, doors)].join(' ');
}

/** What the sweep found on production, and what follows for the issue, as its comment says it.
 *  Only a gated project is read: one that ships nothing, or has no live target, has no production
 *  this issue could reach, and its comment says how that project releases instead. */
export function findingSentence(
  finding: SettleFinding,
  path: ReleasePath = 'gated',
  holds: GateHolds = NO_HOLDS,
  doors: ReleaseDoors = NO_DOORS,
): string {
  const next = backAtGate(path, holds, doors);
  switch (finding.kind) {
    case 'carried':
      return `Production's verified live deployment serves \`${finding.serving}\`. That carries this issue's landing commit \`${finding.landing}\`, so its code has shipped. A release record closes it now.`;
    case 'not-carried':
      return `Production's verified live deployment serves \`${finding.serving}\`. That does not carry this issue's landing commit \`${finding.landing}\`, so its code has not shipped. ${next}`;
    case 'unverified':
      return `This project's live deployment declares no verify probe, so nothing reads what production serves. The sweep closes nothing on a deployment nobody read. A verify probe is set on the live deploy target, under Settings, Integrations. ${next}`;
    case 'no-landing':
      return `This issue carries no landing commit, so nothing can say whether production has its code. ${next}`;
    case 'outside-git':
      return `This issue's work lands outside git, so no commit production serves can show it shipped. The sweep closes nothing on a reading it cannot make. ${next}`;
    case 'not-read':
      return next;
    case 'unread':
      return `What production serves could not be read, so the sweep did not close it. ${next}\n\n${quoted(finding.why)}`;
  }
}

/** A reason another system gave, kept whole on a quoted line rather than spliced into a sentence. */
function quoted(why: string): string {
  return `> ${why.replace(/\s+/g, ' ').trim()}`;
}

/** The whole comment the sweep leaves on a row it takes off Releasing. */
export function settleComment(
  cause: string,
  finding: SettleFinding,
  path: ReleasePath,
  holds: GateHolds,
  doors: ReleaseDoors = NO_DOORS,
): string {
  return [
    `**Releasing, with nothing releasing it.** ${cause}.`,
    "Releasing means a release batch is carrying an issue to production right now. None was, so Forge's releasing sweep has settled it.",
    findingSentence(finding, path, holds, doors),
  ].join('\n\n');
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

async function sweepActor(): Promise<TransitionActor> {
  return { type: 'user', id: await forgeAuthorId(db), agency: 'agent' };
}

/** Back to the gate, the dead claim cleared and the comment posted, in one transaction. */
async function returnToGate(row: StrandedRow, body: string, reason: string): Promise<void> {
  const actor = await sweepActor();
  await transitionIssueStatus(
    {
      id: row.id,
      projectId: row.project_id,
      status: 'releasing',
      reopenCount: row.reopen_count,
    },
    RELEASE_GATE_STATUS,
    actor,
    {
      // The gate's entry records are not re-read: an unearned one would hold the row at Releasing
      // for good, under a door nothing else may pass (ISS-1421 decision record).
      skip: true,
      viaReleasePath: true,
      reason,
      beforeStatusWrite: async (tx) => {
        await fenceAndRelease(tx, row);
        await postSystemComment({ issueId: row.id, authorId: actor.id, body }, tx);
      },
    },
  );
}

async function closeByRecord(
  row: StrandedRow,
  finding: Extract<ProductionFinding, { kind: 'carried' }>,
  cause: string,
): Promise<boolean> {
  const actor = await sweepActor();
  const account =
    `Recorded by Forge's releasing sweep. ${cause}; production's verified live ` +
    `deployment serves ${finding.serving}, which carries this issue's landing commit ${finding.landing}.`;
  try {
    const result = await recordPerformedRelease({
      projectId: row.project_id,
      issueIds: [row.id],
      commit: finding.servingWhole,
      account,
      userId: actor.id,
      actor,
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

/** What the sweep says when the release record that would close a row is refused. */
export function recordRefusedComment(why: string, holds: GateHolds): string {
  const said = [
    'The release record that would close this issue was refused.',
    `It stays at ${GATE}.`,
    ...nextAtGateFor('gated', holds),
  ].join(' ');
  return `${said}\n\n${quoted(why)}`;
}

async function sayRecordRefused(row: StrandedRow, why: string): Promise<void> {
  const holds = await readGateHolds(row.project_id, row.id);
  await postSystemComment({
    issueId: row.id,
    authorId: await forgeAuthorId(db),
    body: recordRefusedComment(why, holds),
  });
}

/** Where this row's work lands; a project kind Forge does not know asks for no landing at all. */
function laneOfRow(row: StrandedRow): LandingShape | null {
  try {
    return laneOrNull(row.declared_lane, row.project_kind)?.shape ?? null;
  } catch {
    return null;
  }
}

/** What production says about this row, read only where a release could have carried it there. */
async function findingFor(
  row: StrandedRow,
  path: ReleasePath,
  read: (projectId: string) => Promise<ProductionReading>,
): Promise<SettleFinding> {
  if (path !== 'gated') return { kind: 'not-read' };
  const lane = laneOfRow(row);
  if (lane === 'outside_git') return { kind: 'outside-git' };
  if (!row.landing) return lane === 'git' ? { kind: 'no-landing' } : { kind: 'not-read' };
  return (await read(row.project_id)).forLanding(row.landing);
}

async function settleOne(
  row: StrandedRow,
  read: (projectId: string) => Promise<ProductionReading>,
  pathOf: (projectId: string) => Promise<ReleasePath>,
): Promise<'closed' | 'returned'> {
  const cause = strandedCause(row);
  const path = await pathOf(row.project_id);
  const finding = await findingFor(row, path, read);
  // A row production carries is closed below, so only a row left at the gate is told what holds it.
  const holds =
    path === 'gated' && finding.kind !== 'carried'
      ? await readGateHolds(row.project_id, row.id)
      : NO_HOLDS;
  const doors = await readReleaseDoors(row.project_id, path);
  const body = settleComment(cause, finding, path, holds, doors);
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
  const paths = new Map<string, Promise<ReleasePath>>();
  const pathOf = (projectId: string) => {
    const kept = paths.get(projectId);
    if (kept) return kept;
    const fresh = readReleasePath(projectId);
    paths.set(projectId, fresh);
    return fresh;
  };
  const read = (projectId: string) => {
    const kept = readings.get(projectId);
    if (kept) return kept;
    const fresh = (deps.production ?? readProductionFinding)(projectId);
    readings.set(projectId, fresh);
    return fresh;
  };

  for (const row of rows) {
    try {
      const outcome = await settleOne(row, read, pathOf);
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
