/** One deploy reaches one environment at a time (ISS-1279). The shared resource is the deployment,
 *  not the roster, so the hold is keyed on `(project, environment)`; the roster-keyed
 *  `BATCH_IN_FLIGHT` beside it is ISS-1280's to remove. Every instant here comes from `now()`
 *  inside the statement, so a drifted application clock cannot make a dead holder look alive. */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { DEPLOY_CONFIRM_WINDOW_MS } from './deploy-confirmations.js';

export const DEPLOY_ENVIRONMENT_LOCKED = 'DEPLOY_ENVIRONMENT_LOCKED';

/** How long an acquire waits on one that has neither committed nor rolled back: expiry does not
 *  free a transaction's row lock, so an unbounded wait would wedge every later deploy. */
export const DEPLOY_LOCK_WAIT_MS = 3_000;

/** Postgres `lock_not_available`, raised when `lock_timeout` runs out. */
const LOCK_NOT_AVAILABLE = '55P03';

export interface DeployLockRequest {
  projectId: string;
  /** The run that holds it, and whose settlement frees it. */
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
 *  committed — and the message says so rather than inventing one. */
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

export async function readDeployLock(
  projectId: string,
  environment: string,
): Promise<DeployLockHolder | null> {
  const rows = await db.execute<LockRow>(sql`
    SELECT project_id, environment, run_id, subject, acquired_at, expires_at
      FROM deploy_locks
     WHERE project_id = ${projectId} AND environment = ${environment}
     LIMIT 1
  `);
  const [row] = rows;
  return row ? asHolder(row) : null;
}

/** All the environments this deploy reaches, or none: one refused its second never dispatches, so
 *  a first left held would be freed by nothing but the expiry. */
export async function acquireDeployLocks(
  request: DeployLockRequest,
  environments: readonly string[],
): Promise<void> {
  // Sorted, so two deploys wanting the same pair cannot each hold one and wait on the other.
  const wanted = [...new Set(environments)].sort();
  if (wanted.length === 0) return;
  let waitedOn = wanted[0] as string;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${DEPLOY_LOCK_WAIT_MS}`));
      for (const environment of wanted) {
        waitedOn = environment;
        // Postgres evaluates the `WHERE` under the conflicting row's lock: of two acquires arriving together, exactly one returns a row.
        const taken = await tx.execute<{ environment: string }>(sql`
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
          RETURNING environment
        `);
        if (taken.length > 0) continue;
        throw new DeployEnvironmentLockedError(
          environment,
          await readDeployLock(request.projectId, environment),
        );
      }
    });
  } catch (err) {
    if (isLockWaitTimeout(err)) throw new DeployEnvironmentLockedError(waitedOn, null);
    throw err;
  }
}

/** Drizzle keeps the driver's error on `cause`, so the SQLSTATE is read from either: reading the
 *  outer one alone is how this refusal becomes an unhandled query error instead. */
function isLockWaitTimeout(err: unknown): boolean {
  const outer = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return outer?.code === LOCK_NOT_AVAILABLE || outer?.cause?.code === LOCK_NOT_AVAILABLE;
}

/** Keyed on the run alone, so one that took no lock frees nothing and one whose hold was
 *  reclaimed cannot free the successor that took it. */
export async function releaseDeployLocksForRun(runId: string): Promise<number> {
  const freed = await db.execute<{ environment: string }>(sql`
    DELETE FROM deploy_locks WHERE run_id = ${runId} RETURNING environment
  `);
  return freed.length;
}
