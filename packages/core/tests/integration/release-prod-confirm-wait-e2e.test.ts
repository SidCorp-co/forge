/**
 * ISS-1096 (sidpeak 0.24.0 and 0.25.0, 2026-11-07): a release run's production deploy answered
 * `{ dispatched: false, pendingHumanConfirm: true, reason: 'awaiting-prod-confirm' }`, and nothing on
 * the release said a person owed the confirm press: it read "the release run is working on
 * production", so the release job, finding no way forward, aborted the run and burned the version.
 * Through the app's own doors: the pending answer leaves the release waiting on a person who may
 * press the confirm, with the act and its door; that person is told once, in Needs you, as one
 * decision whose button is the confirm; the run is not closed while it waits, even once its job
 * ended; and a confirm pressed later carries the same run on, with a release job to finish it.
 *
 * @direct-test-of packages/core/src/release-batch/release-view.ts
 * @direct-test-of packages/core/src/release-batch/coolify-prod-gate.ts
 * @direct-test-of packages/core/src/release-batch/release-coolify.ts
 * @direct-test-of packages/core/src/release-batch/coolify-commands.ts
 * @direct-test-of packages/core/src/pipeline/runs-concluded.ts
 * @direct-test-of packages/core/src/integration-door/coolify-routes.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { registerAllIntegrations, releaseWorld } from '../helpers/release-world.js';

const COMMIT = 'de7ccf81'.padEnd(40, '0');
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'github',
    fullName: 'acme/sidpeak',
    branchHead: async () => COMMIT,
  }),
}));

let projectId = '';
let ownerId = '';
let token = '';
let agentToken = '';
let bindingId = '';
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  registerAllIntegrations();
  await startQueue();
  const { boss } = await import('../../src/queue/boss.js');
  const { INTEGRATIONS_QUEUE_NAME } = await import('../../src/queue/names.js');
  await boss.createQueue(INTEGRATIONS_QUEUE_NAME);
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
  agentToken = await userToken(agentId);
  // production deploys on request: a release run's production deploy parks for a person's confirm
  bindingId = await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [APP] }, 'none');
  await fx.seedReleaseRunner();
});

type Doc = Record<string, unknown>;

const call = async (method: 'GET' | 'POST', path: string, body?: unknown, as = token) => {
  const res = await api(as, method, `/api/projects/${projectId}${path}`, body);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as Doc;
};

async function parkedRelease(): Promise<{ runId: string; version: string }> {
  const id = await fx.insertIssue();
  const cut = await fx.claim([id]);
  const answer = await call('POST', '/integrations/coolify/deploy', { pipelineRunId: cut.runId });
  expect(answer).toMatchObject({
    dispatched: false,
    pendingHumanConfirm: true,
    reason: 'awaiting-prod-confirm',
  });
  return { runId: cut.runId, version: String(cut.version) };
}

type Waiting = { kind: string; who: string; act: string; rule: string; says: { act: Doc } };
const waitingOf = async (version: string, as = token) => {
  const detail = await call('GET', `/releases/${version}`, undefined, as);
  return detail.release as Doc & { waitingOn: Waiting; attentionGroup: string };
};

describe('a release whose production deploy waits on a person’s confirm', () => {
  it('reads waiting on the person who may confirm, with the act and the door, never on its own run', async () => {
    const { version } = await parkedRelease();

    const mine = await waitingOf(version);
    expect(mine.waitingOn.says.act).toMatchObject({ key: 'standing.act.confirmProdDeploy' });
    expect(mine.waitingOn.kind).toBe('you');
    expect(mine.attentionGroup).toBe('needs_you');
    expect(mine.waitingOn.rule).toContain(
      `POST /api/projects/${projectId}/integrations/${bindingId}/confirm-prod-deploy`,
    );

    // an agent holding project.admin is never the person: it reads the wait as the person's
    const theirs = await waitingOf(version, agentToken);
    expect(theirs.waitingOn.kind).toBe('person');
    expect(theirs.waitingOn.who).toContain('Sid');
    expect(theirs.waitingOn.act).toBe(`confirm the production deploy of ${version}`);
  });

  it('is told once, in Needs you, as one decision whose button is the confirm', async () => {
    const { version } = await parkedRelease();
    // a second pending answer is the same wait, never a second row
    await call('POST', '/integrations/coolify/deploy', {
      pipelineRunId: (await rows<{ id: string }>(sql`
        SELECT id FROM pipeline_runs WHERE release_version = ${version}`))[0]?.id,
    });

    const read = await call('GET', '/needs-you/decisions');
    const confirms = (read.decisions as Doc[]).filter((d) =>
      (d.answers as Doc[]).some((a) => a.act === 'release.confirmDeploy'),
    );
    expect(confirms).toHaveLength(1);
    const [button] = (confirms[0] as Doc).answers as Doc[];
    expect(button?.path).toBe(
      `/api/projects/${projectId}/integrations/${bindingId}/confirm-prod-deploy`,
    );
  });

  it('keeps its run open while it waits, even once its job ended, and a later confirm carries it on', async () => {
    const { runId } = await parkedRelease();
    // the release job ended long ago: the concluded-run sweep would close a run every job of which ended
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`
        UPDATE jobs SET status = 'done', finished_at = now() - interval '2 days',
                        created_at = now() - interval '2 days'
         WHERE pipeline_run_id = ${runId}`),
    );
    const { reapConcludedRuns } = await import('../../src/pipeline/runs-concluded.js');
    await reapConcludedRuns(new Date(), { projectId });
    const [open] = await rows<{ status: string }>(sql`
      SELECT status FROM pipeline_runs WHERE id = ${runId}`);
    expect(open?.status).toBe('running');

    await call('POST', `/integrations/${bindingId}/confirm-prod-deploy`, {});

    const [run] = await rows<{ status: string; step: string | null; gate: Doc | null }>(sql`
      SELECT status, current_step AS step, metadata->'__forge_prod_deploy_gate' AS gate
        FROM pipeline_runs WHERE id = ${runId}`);
    expect(run?.status).toBe('running');
    expect(run?.step).toBe('release.deploy.in_flight');
    expect(((run?.gate as Doc)[bindingId] as Doc).confirmedByUserId).toBe(ownerId);
    // no release session is alive to carry on, so a release job is queued on the same run to finish it
    const queued = await rows<{ id: string }>(sql`
      SELECT id FROM jobs WHERE pipeline_run_id = ${runId} AND type = 'release_batch'
         AND status IN ('queued', 'dispatched')`);
    expect(queued).toHaveLength(1);
  });
});
