/**
 * ISS-1253 (FB-649, sidpeak 0.27.0, run 1fe92dc2, 2026-11-16): a release run asked for approval at
 * 04:36Z and its production act was refused RELEASE_AWAITING_APPROVAL. Its agent ended the turn to
 * wait; the box concluded the idle pane (`job_exit.rs:IDLE_BEFORE_FINISHED`) and failed the job, the
 * pool retried it with a fresh agent that found the same wait, and the run ended `cancelled` at
 * 05:16Z, its roster re-drafted as 0.28.0 and the master told to cut it. A run parked on its
 * approval holds its version and roster through its job's end, and only the decision, or a person
 * withdrawing it, ends it.
 *
 * @direct-test-of packages/core/src/release-batch/release-park.ts
 * @direct-test-of packages/core/src/release-batch/approval-wake.ts
 * @direct-test-of packages/core/src/release-batch/confirm-resume.ts
 * @direct-test-of packages/core/src/release-batch/finish.ts
 * @direct-test-of packages/core/src/pipeline/parked-run.ts
 * @direct-test-of packages/core/src/pipeline/runs-concluded.ts
 * @direct-test-of packages/core/src/jobs/retry.ts
 * @direct-test-of packages/core/src/jobs/agent-session-link.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { api, patToken, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { registerAllIntegrations, releaseWorld } from '../helpers/release-world.js';

const COMMIT = 'a1b2c3d4'.padEnd(40, '0');
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };
// what the box tells core once a release pane has sat at an ended turn (`job_exit.rs:Verdict::Finished`)
const IDLE_ENDED =
  "the job's pane `forge-job-1` has reported nothing since its agent ended a turn 15m ago — a job pane is briefed once and has nothing left to do after its last turn, so the slot it held was holding a finished agent and not work in flight";

let projectId = '';
let ownerId = '';
let token = '';
let agentToken = '';
let deviceId = '';
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  registerAllIntegrations();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  await db.execute(sql`UPDATE users SET display_name = 'Sid' WHERE id = ${ownerId}`);
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  agentToken = await patToken(agentId, [projectId]);
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [APP] }, 'none');
  // accept mode: production waits on a person's approval (REQ-71 BC-1)
  await db.execute(sql`
    UPDATE project_config_documents
       SET document = jsonb_set(document, '{release,approval,required}', 'true'::jsonb)
     WHERE project_id = ${projectId}`);
  const runnerId = await fx.seedReleaseRunner();
  const [runner] = await rows<{ device_id: string }>(sql`
    SELECT device_id FROM runners WHERE id = ${runnerId}`);
  deviceId = String(runner?.device_id);
});

type Doc = Record<string, unknown>;

/** A cut release whose job ran, asked for approval, and is waiting on it undecided. */
async function parkedOnApproval(): Promise<{ runId: string; version: string; issueId: string }> {
  const issueId = await fx.insertIssue();
  const cut = await fx.claim([issueId]);
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      UPDATE jobs SET status = 'dispatched', device_id = ${deviceId}, dispatched_at = now(),
                      acked_at = now()
       WHERE pipeline_run_id = ${cut.runId}`),
  );
  await db.execute(sql`
    INSERT INTO release_approvals (project_id, run_id, requested_by_user, evidence_commit, evidence_reading)
    VALUES (${projectId}, ${cut.runId}, ${ownerId}, ${COMMIT}, 'GET /api/health 200 on staging')`);
  const { assertApprovalAllowsAttempt } = await import('../../src/release-batch/approvals.js');
  await expect(assertApprovalAllowsAttempt(cut.runId, projectId)).rejects.toMatchObject({
    refusals: [{ code: 'RELEASE_AWAITING_APPROVAL' }],
  });
  return { runId: cut.runId, version: String(cut.version), issueId };
}

/** The box concludes the idle pane, as it did to sidpeak's: the job fails with its words. */
async function paneConcluded(runId: string) {
  const [job] = await db.execute<Doc>(sql`
    SELECT id, project_id AS "projectId", device_id AS "deviceId", status,
           agent_session_id AS "agentSessionId", acked_at AS "ackedAt", error,
           kill_requested_at AS "killRequestedAt", cancellation_requested AS "cancellationRequested"
      FROM jobs WHERE pipeline_run_id = ${runId} AND status = 'dispatched'`);
  const { failJobFromRunner } = await import('../../src/jobs/runner-finish.js');
  return failJobFromRunner(job as never, { error: IDLE_ENDED }, deviceId);
}

const runOf = async (runId: string) =>
  (
    await rows<{ status: string; version: string | null }>(sql`
      SELECT status, release_version AS version FROM pipeline_runs WHERE id = ${runId}`)
  )[0];

const liveJobs = (runId: string) =>
  rows<{ id: string; prompt: string | null }>(sql`
    SELECT id, payload->>'promptString' AS prompt FROM jobs
     WHERE pipeline_run_id = ${runId} AND type = 'release_batch'
       AND status IN ('queued', 'dispatched', 'held')`);

describe('a release run parked on its approval', () => {
  it('outlives its job: no retry, no close, no sweep, its version and roster held', async () => {
    const { runId, version, issueId } = await parkedOnApproval();

    const ended = await paneConcluded(runId);
    expect(ended.retry).toEqual({ scheduled: false, reason: 'release_parked_on_person' });
    expect(await liveJobs(runId)).toHaveLength(0);
    expect(await runOf(runId)).toEqual({ status: 'running', version });
    expect((await fx.stored(issueId)).claim).toBe(runId);

    // the concluded-run sweep reads every job ended long ago, and still leaves it open
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`
        UPDATE jobs SET finished_at = now() - interval '2 days', created_at = now() - interval '2 days'
         WHERE pipeline_run_id = ${runId}`),
    );
    const { reapConcludedRuns } = await import('../../src/pipeline/runs-concluded.js');
    await reapConcludedRuns(new Date(), { projectId });
    expect(await runOf(runId)).toEqual({ status: 'running', version });
  });

  it('is carried on by the decision: a release job queued on the same run, the same version', async () => {
    const { runId, version } = await parkedOnApproval();
    await paneConcluded(runId);

    const [decided] = await rows<{ id: string; decided_at: Date }>(sql`
      UPDATE release_approvals SET decision = 'approved', decided_by_user = ${ownerId},
                                   decided_at = now(), carried = '[]'::jsonb
       WHERE run_id = ${runId} RETURNING id, decided_at`);
    const { tellReleaseRun } = await import('../../src/release-batch/approval-wake.js');
    const told = await tellReleaseRun({
      projectId,
      runId,
      approvalId: String(decided?.id),
      decision: 'approved',
      reason: null,
      carried: [],
      decidedBy: ownerId,
      decidedAt: new Date(String(decided?.decided_at)).toISOString(),
    });
    expect(told).toBe('job_queued');
    const [queued] = await liveJobs(runId);
    expect(queued?.prompt).toMatch(/^Release approval .+ was APPROVED by Sid/);
    expect(await runOf(runId)).toEqual({ status: 'running', version });
  });

  it('refuses its abort by an agent by name; a person withdraws it, naming its version', async () => {
    const { runId, version, issueId } = await parkedOnApproval();
    const abort = `/api/projects/${projectId}/release-batches/${runId}/abort`;
    const body = { reason: 'waited on the approval long enough', carried: [] };

    const refused = await api(agentToken, 'POST', abort, body);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const refusal = JSON.stringify(refused.body);
    expect(refusal).toContain('RELEASE_ABORT_AWAITS_APPROVAL');
    expect(refusal).toContain(`release ${version}`);
    expect(refusal).toContain('Sid');
    expect(await runOf(runId)).toEqual({ status: 'running', version });
    expect((await fx.stored(issueId)).claim).toBe(runId);

    const withdrawn = await api(token, 'POST', abort, body);
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body).toMatchObject({ aborted: true, version });
    expect((await runOf(runId))?.status).toBe('cancelled');
  });

  it('opens the abort once the approval is returned, and the run ends naming its version', async () => {
    const { runId, version } = await parkedOnApproval();
    const { decideApprovalOfVersion } = await import('../../src/release-batch/approvals.js');
    await decideApprovalOfVersion({
      projectId,
      version,
      userId: ownerId,
      decision: { decision: 'return', reason: 'staging shows the old header' },
    });
    await settleOutbox();

    const ended = await api(
      agentToken,
      'POST',
      `/api/projects/${projectId}/release-batches/${runId}/abort`,
      {
        reason: 'returned: staging shows the old header',
        carried: [],
      },
    );
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body).toMatchObject({ aborted: true, version });
  });

  it('owes the master no cut while it waits, and reads waiting on its approver', async () => {
    const { runId, version } = await parkedOnApproval();
    await paneConcluded(runId);

    const { releaseActsOwed } = await import('../../src/release-batch/master-owed-acts.js');
    expect(await releaseActsOwed(projectId)).toEqual([]);

    const detail = await api(agentToken, 'GET', `/api/projects/${projectId}/releases/${version}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const release = (detail.body as Doc).release as Doc & {
      state: string;
      waitingOn: { kind: string; who: string; says: { act: Doc } };
    };
    expect(release.state).toBe('awaiting_approval');
    expect(release.waitingOn.kind).toBe('person');
    expect(release.waitingOn.who).toContain('Sid');
    expect(release.waitingOn.says.act).toMatchObject({ key: 'standing.act.approve' });
  });
});
