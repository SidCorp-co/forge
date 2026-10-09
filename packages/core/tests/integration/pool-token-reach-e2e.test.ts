/**
 * Which box an onboarding job is offered to, read as the REST door reads a box's token (FB-78).
 *
 * - A box whose credential is fenced to no project (`project_ids = []`, the fence a person-held box
 *   is minted with) reaches nothing at the REST door, so the pool does not offer it the job and the
 *   claim is refused POOL_TOKEN_CANNOT_REACH.
 * - A box fenced to the project, and one whose token carries no fence at all (`project_ids` null,
 *   which the REST door reads as every project), are offered it.
 * - While no box serving the project reaches it, the job's gate reason is `token_cannot_reach`
 *   rather than none.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

type Fence = 'none' | 'project' | 'unfenced';

interface Box {
  device: string;
  runner: string;
  pat: string;
}

let projectId = '';
let adminId = '';
const boxes = {} as Record<Fence, Box>;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const admin = await createTestUser({ verified: true });
  adminId = admin.id;
  projectId = (await createTestProject(admin.id)).id;
  await addProjectMember(projectId, admin.id, 'admin');
  const fences: Record<Fence, string[] | null> = {
    none: [],
    project: [projectId],
    unfenced: null,
  };
  for (const fence of ['none', 'project', 'unfenced'] as const) {
    const device = await createTestDevice(admin.id);
    const runner = await bindTestRunner(projectId, device);
    const pat = (
      await mintPat({
        permissions: ['*'],
        userId: admin.id,
        name: `box-${fence}`,
        deviceId: device,
        projectIds: fences[fence],
      })
    ).plaintext;
    boxes[fence] = { device, runner, pat };
  }
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const asBox = async (fence: Fence, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const res = await api(boxes[fence].pat, method, path, body);
  return { status: res.status, body: res.body as Doc };
};

async function queueOnboardingJob(): Promise<string> {
  const runId = randomUUID();
  const jobId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, payload)
    VALUES (${jobId}, ${projectId}, ${runId}, ${adminId}, 'onboarding', 'queued',
            ${JSON.stringify({ promptString: 'analyse the project' })}::jsonb)
  `);
  return jobId;
}

async function offered(fence: Fence, jobId: string): Promise<boolean> {
  const res = await asBox(fence, 'GET', `/api/devices/me/pool?projectId=${projectId}`);
  expect(res.status).toBe(200);
  return (res.body.items as Array<{ jobId: string }>).some((item) => item.jobId === jobId);
}

/** Only these boxes heartbeat, so only they count as serving the project. */
async function serving(...fences: Fence[]): Promise<void> {
  await db.execute(sql`UPDATE runners SET last_seen_at = NULL WHERE project_id = ${projectId}`);
  for (const fence of fences) {
    await db.execute(sql`UPDATE runners SET last_seen_at = now() WHERE id = ${boxes[fence].runner}`);
  }
}

describe('an onboarding job, offered by what the box credential reaches', () => {
  it('reads an empty fence as reaching nothing, as the REST door does', async () => {
    const project = await asBox('none', 'GET', `/api/projects/${projectId}`);
    expect(project.status).toBe(404);
    const jobId = await queueOnboardingJob();
    expect(await offered('none', jobId)).toBe(false);
    expect(await offered('project', jobId)).toBe(true);
    expect(await offered('unfenced', jobId)).toBe(true);
  });

  it('refuses the claim POOL_TOKEN_CANNOT_REACH on a box fenced to no project', async () => {
    const jobId = await queueOnboardingJob();
    const { runnerAdmission } = await import('../../src/devices/pool-admission.js');
    expect(await runnerAdmission({ jobId, deviceId: boxes.none.device })).toEqual({
      admitted: false,
      reason: 'token_cannot_reach',
    });
    expect(await runnerAdmission({ jobId, deviceId: boxes.project.device })).toEqual({
      admitted: true,
    });
    expect(await runnerAdmission({ jobId, deviceId: boxes.unfenced.device })).toEqual({
      admitted: true,
    });
    const claim = await asBox('none', 'POST', '/api/devices/me/pool/prepare', {
      jobId,
      sessionId: randomUUID(),
    });
    expect(claim.body?.error?.code).toBe('POOL_TOKEN_CANNOT_REACH');
  });

  it('names token_cannot_reach as the gate while no serving box reaches the project', async () => {
    const jobId = await queueOnboardingJob();
    const { gateReasonsForQueuedJobsIn } = await import('../../src/jobs/queued-gates.js');
    await serving('none');
    expect((await gateReasonsForQueuedJobsIn([projectId])).get(jobId)).toBe('token_cannot_reach');
    await serving('none', 'project');
    expect((await gateReasonsForQueuedJobsIn([projectId])).get(jobId)).toBeUndefined();
    await serving('unfenced');
    expect((await gateReasonsForQueuedJobsIn([projectId])).get(jobId)).toBeUndefined();
  });

  it('leaves the gate to a box whose only credential was revoked', async () => {
    const jobId = await queueOnboardingJob();
    const { gateReasonsForQueuedJobsIn } = await import('../../src/jobs/queued-gates.js');
    await serving('project');
    await db.execute(sql`
      UPDATE personal_access_tokens SET revoked_at = now() WHERE device_id = ${boxes.project.device}
    `);
    expect((await gateReasonsForQueuedJobsIn([projectId])).get(jobId)).toBe('token_cannot_reach');
  });
});
