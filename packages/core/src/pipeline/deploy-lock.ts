/** One deploy reaches one environment at a time (ISS-1279). The shared resource is the deployment,
 *  not the roster, so the hold is keyed on `(project, environment)`; the roster-keyed
 *  `BATCH_IN_FLIGHT` beside it is ISS-1280's to remove. Every instant comes from `now()` inside
 *  the statement, so a drifted application clock cannot make a dead holder look alive. */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pgErrorCode } from '../lib/db-errors.js';
import {
  DEPLOY_CONFIRM_WINDOW_MS,
  type DeployHolds,
  type DeployLockRef,
} from './deploy-confirmations.js';

export const DEPLOY_ENVIRONMENT_LOCKED = 'DEPLOY_ENVIRONMENT_LOCKED';

/** Expiry frees no transaction's row lock, so an acquire waiting on one needs its own bound. */
export const DEPLOY_LOCK_WAIT_MS = 3_000;

/** Postgres `lock_not_available`, raised when `lock_timeout` runs out. */
const LOCK_NOT_AVAILABLE = '55P03';

export interface DeployLockRequest {
  projectId: string;
  runId: string;
  subject: string;
}

export interface DeployLockHolder {
  projectId: string;
  environment: string;
  runId: string;
  subject: string;
  acquiredAt: string;
  expiresAt: string;
}

/** `holder` is null only where nothing could be read — a concurrent acquire that has not
 *  committed — and the message says so. */
export class DeployEnvironmentLockedError extends Error {
  readonly code = DEPLOY_ENVIRONMENT_LOCKED;

  constructor(
    readonly environment: string,
    readonly holder: DeployLockHolder | null,
  ) {
    super(deployEnvironmentLockedMessage(environment, holder));
    this.name = 'DeployEnvironmentLockedError';
  }
}

export function deployEnvironmentLockedMessage(
  environment: string,
  holder: DeployLockHolder | null,
): string {
  if (!holder) {
    return (
      `${DEPLOY_ENVIRONMENT_LOCKED}: an acquisition of the \`${environment}\` environment is in ` +
      `flight and has not committed, so after ${DEPLOY_LOCK_WAIT_MS}ms this deploy could take ` +
      'neither the hold nor a reading of who holds it. Nothing was dispatched and nothing was ' +
      'queued for later. Deploy again once that acquisition has settled.'
    );
  }
  return (
    `${DEPLOY_ENVIRONMENT_LOCKED}: the \`${environment}\` environment is already being deployed ` +
    `to. Pipeline run ${holder.runId} took the hold at ${holder.acquiredAt} and is deploying ` +
    `${holder.subject}. One deploy reaches one environment at a time, so nothing was dispatched ` +
    'and nothing was queued for later. The hold ends when that deploy ends, success or failure, ' +
    `or at ${holder.expiresAt}, after which the next deploy reclaims it.`
  );
}

interface LockRow extends Record<string, unknown> {
  project_id: string;
  environment: string;
  run_id: string;
  subject: string;
  acquired_at: string | Date;
  expires_at: string | Date;
}

const asHolder = (row: LockRow): DeployLockHolder => ({
  projectId: row.project_id,
  environment: row.environment,
  runId: row.run_id,
  subject: row.subject,
  acquiredAt: new Date(row.acquired_at).toISOString(),
  expiresAt: new Date(row.expires_at).toISOString(),
});

/** `exec` is the open transaction: the pool is ten wide, and an acquire asking it for an eleventh
 *  connection while holding its own waits past the `lock_timeout` set. */
async function readLockWith(
  exec: Pick<typeof db, 'execute'>,
  projectId: string,
  environment: string,
): Promise<DeployLockHolder | null> {
  const rows = await exec.execute<LockRow>(sql`
    SELECT project_id, environment, run_id, subject, acquired_at, expires_at
      FROM deploy_locks
     WHERE project_id = ${projectId} AND environment = ${environment}
     LIMIT 1
  `);
  const [row] = rows;
  return row ? asHolder(row) : null;
}

export async function readDeployLock(
  projectId: string,
  environment: string,
): Promise<DeployLockHolder | null> {
  return readLockWith(db, projectId, environment);
}

/** All the environments this deploy reaches, or none: refused its second, it never dispatches, and
 *  a first left held would be freed by nothing but the expiry.
 *
 *  @returns the rows THIS acquisition took: a read afterwards can hand back a successor's.
 */
export async function acquireDeployLocks(
  request: DeployLockRequest,
  environments: readonly string[],
): Promise<DeployLockHeld[]> {
  // Sorted, so two deploys wanting the same pair cannot each hold one and wait on the other.
  const wanted = [...new Set(environments)].sort();
  if (wanted.length === 0) return [];
  const taken: DeployLockHeld[] = [];
  let waitedOn = wanted[0] as string;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${DEPLOY_LOCK_WAIT_MS}`));
      for (const environment of wanted) {
        waitedOn = environment;
        // Postgres evaluates the `WHERE` under the conflicting row's lock: of two acquires arriving together, exactly one returns a row.
        const rows = await tx.execute<{ environment: string; acquired_at: string }>(sql`
          INSERT INTO deploy_locks (project_id, environment, run_id, subject, acquired_at, expires_at)
          VALUES (${request.projectId}, ${environment}, ${request.runId}, ${request.subject},
                  now(), now() + ${DEPLOY_CONFIRM_WINDOW_MS} * interval '1 millisecond')
          ON CONFLICT (project_id, environment) DO UPDATE
             SET run_id = excluded.run_id,
                 subject = excluded.subject,
                 acquired_at = excluded.acquired_at,
                 expires_at = excluded.expires_at,
                 reclaimed_from_run_id = deploy_locks.run_id,
                 reclaimed_at = now()
           WHERE deploy_locks.expires_at <= now()
          RETURNING environment, acquired_at::text AS acquired_at
        `);
        const row = rows[0];
        if (row) {
          taken.push({ environment: row.environment, acquiredAt: row.acquired_at });
          continue;
        }
        throw new DeployEnvironmentLockedError(
          environment,
          await readLockWith(tx, request.projectId, environment),
        );
      }
    });
  } catch (err) {
    if (pgErrorCode(err) === LOCK_NOT_AVAILABLE)
      throw new DeployEnvironmentLockedError(waitedOn, null);
    throw err;
  }
  return taken;
}

/** A reacquire moves `acquired_at`, telling this hold from the next on the same environment.
 *  `acquiredAt` is Postgres' own rendering, carried back verbatim — a JS `Date` truncates the
 *  microseconds it has to match on. */
export type DeployLockHeld = DeployLockRef;

/** Keyed on the run: one that took no lock frees nothing, one whose hold was reclaimed cannot free
 *  the successor, and `held` narrows it to the rows a reading accounted for. */
export async function releaseDeployLocksForRun(
  runId: string,
  held?: readonly DeployLockHeld[],
): Promise<number> {
  if (held && held.length === 0) return 0;
  const only = held
    ? sql` AND (environment, acquired_at) IN (${sql.join(
        held.map((h) => sql`(${h.environment}, ${h.acquiredAt}::timestamptz)`),
        sql`, `,
      )})`
    : sql``;
  const freed = await db.execute<{ environment: string }>(sql`
    DELETE FROM deploy_locks WHERE run_id = ${runId}${only} RETURNING environment
  `);
  return freed.length;
}

/** An EMPTY record is not idle: freeing on refused or unwritten holds joins a live deploy. */
export const deployHoldsIdle = (holds: DeployHolds): boolean =>
  Object.keys(holds).length > 0 && Object.values(holds).every((h) => h.status !== 'pending');

/** The lock rows the record NAMES, by identity: one it never accounted for is a later taker's. */
export const deployHoldsLocks = (holds: DeployHolds): DeployLockHeld[] => {
  const byId = new Map<string, DeployLockHeld>();
  for (const hold of Object.values(holds)) {
    for (const l of hold.locks ?? []) byId.set(`${l.environment}@${l.acquiredAt}`, l);
  }
  return [...byId.values()];
};
