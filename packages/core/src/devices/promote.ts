/**
 * Turning one backlog row into work (ISS-917).
 *
 * The backlog is read-only. This is the separate, explicit act that makes a row
 * claimable: it moves the issue to the entry status and lets the dispatch every
 * other caller uses turn that into a run and a `drive` job, then hands the job
 * id back so the master claims it through `/me/pool/claim` unchanged.
 *
 * It is NOT the manual-Run path. `dispatchDriveManual` bypasses the entry gate
 * deliberately, because a human pressing "Run" IS the human the gate waits for.
 * A master is not, so promotion goes through the gate like any other dispatch.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, jobs, pipelineRuns } from '../db/schema.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { AUTONOMOUS_ENTRY_STATUS, AUTONOMOUS_JOB_TYPE } from '../pipeline/autonomous-mode.js';
import { isEntryGateClosed } from '../pipeline/autonomous-dispatch.js';
import { reEnqueueForIssue } from '../pipeline/orchestrator.js';
import { pipelineConfigSchema } from '../pipeline/pipeline-config-schema.js';

export type PromoteResult =
  | { ok: true; jobId: string; issueId: string; issueKey: string | null }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'backlog_disabled'
        | 'not_in_backlog'
        | 'entry_gated'
        | 'issue_busy'
        | 'dispatch_failed';
      detail: string;
    };

type Loaded = {
  issueId: string;
  projectId: string;
  status: string;
  reopenCount: number;
  issueKey: string | null;
  admitted: string[];
  cfg: ReturnType<typeof pipelineConfigSchema.safeParse>;
  createdBy: string | null;
};

// cm:guard join `runners` so the device sees only projects it actually serves, and answer `not_found` (never `forbidden`) for anything else — this route runs on the DEVICE principal precisely so it cannot borrow its owner's account authority, and a distinguishable "exists but not yours" would hand a paired box a project-existence oracle its bindings do not cover.
async function loadPromotable(deviceId: string, issueId: string): Promise<Loaded | null> {
  const rows = (await db.execute(sql`
    SELECT i.id, i.project_id, i.status, i.reopen_count, i.iss_seq,
           p.agent_config, p.created_by, p.archived_at
    FROM issues i
    JOIN projects p ON p.id = i.project_id
    JOIN runners r ON r.project_id = i.project_id AND r.device_id = ${deviceId}
    WHERE i.id = ${issueId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row || row.archived_at != null) return null;

  const ac = (row.agent_config as { pipelineConfig?: unknown } | null) ?? {};
  const cfg = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  const admitted = cfg.success ? (cfg.data.poolBacklog?.statuses ?? []) : [];

  return {
    issueId: String(row.id),
    projectId: String(row.project_id),
    status: String(row.status),
    reopenCount: Number(row.reopen_count ?? 0),
    issueKey: row.iss_seq == null ? null : `ISS-${row.iss_seq}`,
    admitted,
    cfg,
    createdBy: (row.created_by as string | null) ?? null,
  };
}

/** Any job at all, or an open run — the two shapes that mean work already exists. */
async function workAlreadyExists(issueId: string): Promise<boolean> {
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.issueId, issueId)).limit(1);
  if (job) return true;
  const [run] = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(
      and(eq(pipelineRuns.issueId, issueId), inArray(pipelineRuns.status, ['running', 'paused'])),
    )
    .limit(1);
  return Boolean(run);
}

async function findDriveJob(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.issueId, issueId), eq(jobs.type, AUTONOMOUS_JOB_TYPE)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Promote one backlog issue for the master holding `deviceId`.
 *
 * Every refusal is an ordinary outcome with a name — an entry-gated project and
 * a race lost to another master are both normal, and neither should reach the
 * master as an error it might retry in a loop.
 */
// cm:guard the entry gate is checked BEFORE the status moves, and that ordering is the whole no-orphan guarantee: `dispatchAutonomous` answers a closed gate by enqueuing nothing, so moving first would leave the issue at `open` with no run, no job and nothing saying why — exactly the wedge shape ISS-890 measured.
// cm:edge lockstep -> packages/core/src/pipeline/autonomous-dispatch.ts — `isEntryGateClosed` is THE gate and this must keep calling it rather than re-reading `states.open`; a second copy is what let the two disagree about what "require a human" means per project.
export async function promoteFromBacklog(args: {
  deviceId: string;
  issueId: string;
}): Promise<PromoteResult> {
  const loaded = await loadPromotable(args.deviceId, args.issueId);
  if (!loaded) {
    return {
      ok: false,
      reason: 'not_found',
      detail: 'no such issue in a project this device serves',
    };
  }

  if (loaded.admitted.length === 0) {
    return {
      ok: false,
      reason: 'backlog_disabled',
      detail: 'this project declares no `pipelineConfig.poolBacklog.statuses`, so it has no backlog',
    };
  }
  if (!loaded.admitted.includes(loaded.status)) {
    return {
      ok: false,
      reason: 'not_in_backlog',
      detail: `issue is at \`${loaded.status}\`, which this project does not admit to its backlog (${loaded.admitted.join(', ')})`,
    };
  }

  const cfg = loaded.cfg.success ? loaded.cfg.data : null;
  if (!cfg?.enabled) {
    return {
      ok: false,
      reason: 'entry_gated',
      detail: 'the project pipeline is disabled, so nothing is dispatched',
    };
  }
  if (isEntryGateClosed(cfg)) {
    return {
      ok: false,
      reason: 'entry_gated',
      detail: `\`states.${AUTONOMOUS_ENTRY_STATUS}\` is disabled or set to \`mode: 'manual'\` — a human presses Run on this project, and admitting a status to the backlog widens what a master may SEE, never what it may decide`,
    };
  }

  if (await workAlreadyExists(loaded.issueId)) {
    return {
      ok: false,
      reason: 'issue_busy',
      detail: 'a job or an open pipeline run already exists for this issue',
    };
  }

  const [device] = await db
    .select({ id: devices.id, ownerId: devices.ownerId })
    .from(devices)
    .where(eq(devices.id, args.deviceId))
    .limit(1);
  if (!device) return { ok: false, reason: 'not_found', detail: 'device not found' };

  try {
    await transitionIssueStatus(
      {
        id: loaded.issueId,
        projectId: loaded.projectId,
        status: loaded.status as never,
        reopenCount: loaded.reopenCount,
      },
      AUTONOMOUS_ENTRY_STATUS,
      { type: 'device', id: device.id, ownerId: device.ownerId },
      { reason: 'promoted from the pool backlog by a master agent' },
    );
  } catch (err) {
    if (err instanceof TransitionError) {
      return {
        ok: false,
        reason: 'issue_busy',
        detail: `the issue would not move to \`${AUTONOMOUS_ENTRY_STATUS}\`: ${err.message}`,
      };
    }
    throw err;
  }

  // cm:guard dispatch SYNCHRONOUSLY here rather than waiting on the `transition` hook: the hook runs off the outbox worker, so it cannot hand an id back, and a promote that answered with no `jobId` would make the master poll the pool for a row it cannot recognise. Racing the hook is safe and deliberate — `jobs_active_unique` on (issue_id, type) means whichever loses raises `ActiveJobConflictError` and enqueues nothing.
  await reEnqueueForIssue({
    projectId: loaded.projectId,
    issueId: loaded.issueId,
    status: AUTONOMOUS_ENTRY_STATUS,
    // cm:guard `agency: 'agent'` is not decoration — `actorAgency` reads it at every lifecycle gate, and a device actor is always an agent. The dispatch `Actor` and the transition `TransitionActor` are deliberately different shapes (one records WHO OWNS the write, the other WHO IS AT THE KEYBOARD), so this cannot be the same literal as the transition above.
    actor: { type: 'device', id: device.id, agency: 'agent' },
    reason: { promotedFromBacklog: true, from: loaded.status },
  });

  const jobId = await findDriveJob(loaded.issueId);
  if (jobId) {
    return { ok: true, jobId, issueId: loaded.issueId, issueKey: loaded.issueKey };
  }

  return recoverFailedPromote(loaded, device);
}

/**
 * A promote whose dispatch produced no job. Neither outcome may leave the issue
 * out of its backlog status with nothing accounting for it.
 */
// cm:guard the two branches are NOT interchangeable and the reason must say which one happened: with a run open the issue is a `open`-with-no-job row `resetAutonomousWedgesOnce` already scans and will re-dispatch, so restoring the status would DELETE that rescue (and `draft` refuses the move anyway once a run exists); with no run there is nothing watching, so the status must go back or the issue is stranded where no surface shows it.
async function recoverFailedPromote(
  loaded: Loaded,
  device: { id: string; ownerId: string },
): Promise<PromoteResult> {
  const [run] = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.issueId, loaded.issueId),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
    )
    .limit(1);

  if (run) {
    logger.warn(
      { issueId: loaded.issueId, runId: run.id },
      'promote: no drive job after dispatch, leaving the issue at the entry status for the reconciler',
    );
    return {
      ok: false,
      reason: 'dispatch_failed',
      detail: `no \`${AUTONOMOUS_JOB_TYPE}\` job was enqueued. The issue is at \`${AUTONOMOUS_ENTRY_STATUS}\` with run ${run.id} open, which the reconciler re-dispatches; it is not stranded.`,
    };
  }

  try {
    await transitionIssueStatus(
      {
        id: loaded.issueId,
        projectId: loaded.projectId,
        status: AUTONOMOUS_ENTRY_STATUS,
        reopenCount: loaded.reopenCount,
      },
      loaded.status as never,
      { type: 'device', id: device.id, ownerId: device.ownerId },
      {
        skip: true,
        reason: 'promote produced no drive job — restored to the backlog status',
        transitionReason: 'promote produced no drive job — restored to the backlog status',
      },
    );
  } catch (err) {
    logger.error(
      { err, issueId: loaded.issueId },
      'promote: could not restore the backlog status after a failed dispatch',
    );
    return {
      ok: false,
      reason: 'dispatch_failed',
      detail: `no \`${AUTONOMOUS_JOB_TYPE}\` job was enqueued and the issue could NOT be restored to \`${loaded.status}\` — it is at \`${AUTONOMOUS_ENTRY_STATUS}\` with no run. Move it by hand.`,
    };
  }

  return {
    ok: false,
    reason: 'dispatch_failed',
    detail: `no \`${AUTONOMOUS_JOB_TYPE}\` job was enqueued; the issue was restored to \`${loaded.status}\``,
  };
}
