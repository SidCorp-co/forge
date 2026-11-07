/**
 * ISS-1116 (agenfold 0.207.0, 2026-11-07): the master deployed run 0d199511 by hand at 13:46:42,
 * Coolify ran deployment e8gws4o4o4ow0808o0gc04sg until 13:50:10, and the release_batch job for the
 * same run deployed commit de7ccf81 again at 13:50:02: the compose stack came down twice. Coolify had
 * reported the first one finished, which frees the environment's deploy lock, while the stack was
 * still coming up. Through the REST door every caller uses, a deploy of the same run, binding and
 * commit is answered with the deployment already sent, its state and who sent it, and Coolify is
 * asked once; a repeat while the first still runs is answered the same way, not refused. An explicit
 * redeploy and another commit still go out; another run (or none) is answered from a deploy of that
 * commit still running, and sent once it failed.
 *
 * Coolify is a local HTTP server counting every deploy it is asked for; the source host is planted
 * and answers the head of the branch production deploys from.
 *
 * @direct-test-of packages/core/src/release-batch/deploy-once.ts
 * @direct-test-of packages/core/src/release-batch/release-coolify.ts
 * @direct-test-of packages/core/src/release-batch/coolify-commands.ts
 * @direct-test-of packages/core/src/integrations/deploy/coolify/sent-deploys.ts
 * @direct-test-of packages/core/src/integration-door/coolify-routes.ts
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import type { OutboundDispatchJob } from '../../src/integrations/index.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import {
  landOnProduction,
  registerAllIntegrations,
  releaseWorld,
  seedProductionDeployTrigger,
} from '../helpers/release-world.js';

const COMMIT = 'de7ccf81'.padEnd(40, '0');
const NEXT = 'f00dcafe'.padEnd(40, '1');
const FIRST = 'e8gws4o4o4ow0808o0gc04sg';
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

const repo = vi.hoisted(() => ({ head: '', unreadable: false }));

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'github',
    fullName: 'acme/agenfold',
    branchHead: async () => {
      if (repo.unreadable) throw new Error('GitHub answered HTTP 502 for the branch');
      return repo.head;
    },
  }),
}));

/** Every deploy Coolify was asked for, by application, and the deployment it answered. */
const deployed: string[] = [];
let coolify: Server | null = null;
let coolifyUrl = '';

let projectId = '';
let ownerId = '';
let token = '';
let bindingId = '';
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  coolify = createServer((req, res) => {
    const url = new URL(String(req.url), 'http://coolify');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && url.pathname === '/api/v1/deploy') {
      deployed.push(url.searchParams.get('uuid') ?? '');
      const uuid = deployed.length === 1 ? FIRST : `dep-${deployed.length}`;
      res.end(JSON.stringify({ deployments: [{ deployment_uuid: uuid, message: 'queued' }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{"message":"not found"}');
  });
  await new Promise<void>((done) => coolify?.listen(0, '127.0.0.1', done));
  coolifyUrl = `http://127.0.0.1:${(coolify.address() as AddressInfo).port}`;
  await import('../../src/index.js');
  registerAllIntegrations();
  await startQueue();
  const { boss } = await import('../../src/queue/boss.js');
  const { INTEGRATIONS_QUEUE_NAME } = await import('../../src/queue/names.js');
  await boss.createQueue(INTEGRATIONS_QUEUE_NAME);
}, 120_000);

afterAll(async () => {
  await closeWorld();
  await new Promise<void>((done) => (coolify ? coolify.close(() => done()) : done()));
});

beforeEach(async () => {
  await truncateAll();
  await rows(sql`DELETE FROM pgboss_v12.job WHERE name = 'forge.integrations'`);
  deployed.length = 0;
  repo.head = COMMIT;
  repo.unreadable = false;
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  bindingId = await fx.declareProduction({ baseUrl: coolifyUrl, targets: [APP] }, 'none');
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  await landOnProduction(projectId, ownerId);
  await fx.seedReleaseRunner();
});

type Doc = Record<string, unknown>;

const deploy = async (body: Doc) => {
  const res = await api(token, 'POST', `/api/projects/${projectId}/integrations/coolify/deploy`, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Doc & { alreadySent?: Doc[]; redeployedOver?: Doc[] };
};

/** Run every deploy the door queued, as the integrations worker does, holds included. */
async function work(): Promise<void> {
  const jobs = await rows<{ id: string; data: OutboundDispatchJob }>(sql`
    SELECT id, data FROM pgboss_v12.job WHERE name = 'forge.integrations' ORDER BY created_on`);
  await rows(sql`DELETE FROM pgboss_v12.job WHERE name = 'forge.integrations'`);
  const { runOutboundDispatch } = await import('../../src/integrations/queue.js');
  const { replaceDispatchHoldWithTargets } = await import('../../src/pipeline/index.js');
  for (const job of jobs) {
    await runOutboundDispatch(job.data, {
      onDeployOutcome: async (o) => {
        if (o.runId) {
          await replaceDispatchHoldWithTargets({
            runId: o.runId,
            bindingId: o.bindingId,
            targets: o.targets,
            ...(o.requestId ? { requestId: o.requestId } : {}),
          });
        }
      },
    });
  }
}

/**
 * What the confirm poller does once Coolify reports the deployment ended: the settling row, then the
 * run's hold, which frees the environment's lock (`coolify-confirm.ts:applyDeploySettlement`).
 */
async function settle(uuid: string, verdict: 'succeeded' | 'failed'): Promise<void> {
  const [sent] = await rows<{ id: string; run_id: string | null }>(sql`
    SELECT id, payload->>'runId' AS run_id FROM integration_deliveries
     WHERE direction = 'outbound' AND response->>'deployment_uuid' = ${uuid}`);
  await db.execute(sql`
    INSERT INTO integration_deliveries (binding_id, direction, event_name, request_id, status, payload)
    VALUES (${bindingId}, 'inbound', ${`deploy.${verdict}`}, ${uuid}, 'ok',
            ${JSON.stringify({ source: 'poll', deployment_uuid: uuid, status: verdict })}::jsonb)`);
  const { applyDeploySettlement } = await import('../../src/release-batch/coolify-confirm.js');
  await applyDeploySettlement(
    {
      bindingId,
      runId: sent?.run_id ?? null,
      deliveryId: String(sent?.id),
      deploymentUuid: uuid,
      targetLabel: APP.label,
      commit: COMMIT,
    },
    verdict,
    verdict === 'failed' ? 'the build failed' : undefined,
  );
}

async function releaseRun(): Promise<string> {
  const id = await fx.insertIssue();
  return (await fx.claim([id])).runId;
}

describe('a deploy of the same run, binding and commit is sent once (13:46:42 / 13:50:02)', () => {
  it('answers the job’s call with the hand call’s deployment once Coolify reported it finished', async () => {
    const runId = await releaseRun();
    const hand = await deploy({ pipelineRunId: runId });
    expect(hand).toMatchObject({ dispatched: true });
    await work();
    // Coolify reports e8gws… finished while the compose stack is still coming up; the lock frees
    await settle(FIRST, 'succeeded');

    const job = await deploy({ pipelineRunId: runId });
    await work();

    expect(deployed, 'Coolify asked once').toEqual([APP.resourceUuid]);
    expect(job).toMatchObject({ dispatched: false, reason: 'already-sent' });
    const [sent] = job.alreadySent ?? [];
    expect(sent).toMatchObject({
      integrationId: bindingId,
      deploymentUuid: FIRST,
      state: 'succeeded',
      commit: COMMIT,
      runId,
    });
    expect(String(sent?.says)).toContain(`Already sent on this run: deployment ${FIRST}`);
    expect(String(sent?.says)).toContain('via a signed-in session');
    expect(String(sent?.says)).toContain('`redeploy: true` sends it anyway');
  });

  it('answers a repeat while the first still runs, rather than refusing it', async () => {
    const runId = await releaseRun();
    await deploy({ pipelineRunId: runId });
    await work();

    const again = await deploy({ pipelineRunId: runId });

    expect(again.alreadySent?.[0]).toMatchObject({ state: 'running', deploymentUuid: FIRST });
    expect(deployed).toEqual([APP.resourceUuid]);
  });

  it('answers a repeat while the first is queued and Coolify has not named it yet', async () => {
    const runId = await releaseRun();
    await deploy({ pipelineRunId: runId });

    const second = await deploy({ pipelineRunId: runId });
    await work();

    expect(deployed).toEqual([APP.resourceUuid]);
    expect(second.alreadySent?.[0]).toMatchObject({ state: 'queued', deploymentUuid: null });
  });

  it('answers a repeat whose commit could not be read, which nothing shows differs', async () => {
    const runId = await releaseRun();
    await deploy({ pipelineRunId: runId });
    await work();
    await settle(FIRST, 'succeeded');
    repo.unreadable = true;

    const again = await deploy({ pipelineRunId: runId });

    expect(again.alreadySent?.[0]).toMatchObject({ deploymentUuid: FIRST, commit: COMMIT });
    expect(deployed).toHaveLength(1);
  });

  it('sends an explicit redeploy, naming the deployment it went out over', async () => {
    const runId = await releaseRun();
    await deploy({ pipelineRunId: runId });
    await work();
    await settle(FIRST, 'succeeded');

    const again = await deploy({ pipelineRunId: runId, redeploy: true });
    await work();

    expect(again).toMatchObject({ dispatched: true });
    expect(again.redeployedOver?.[0]).toMatchObject({ deploymentUuid: FIRST });
    expect(deployed).toHaveLength(2);
  });

  it('sends a deploy of another commit on the same run', async () => {
    const runId = await releaseRun();
    await deploy({ pipelineRunId: runId });
    await work();
    await settle(FIRST, 'succeeded');
    repo.head = NEXT;

    const moved = await deploy({ pipelineRunId: runId });
    await work();

    expect(moved).toMatchObject({ dispatched: true });
    expect(moved.alreadySent).toBeUndefined();
    expect(deployed).toHaveLength(2);
  });

  it('answers a deploy with no run from the same commit still running, and sends once it failed', async () => {
    const runId = await releaseRun();
    await deploy({ pipelineRunId: runId });
    await work();

    const runless = await deploy({ integrationId: bindingId });
    expect(runless).toMatchObject({ dispatched: false, reason: 'already-sent' });
    expect(String(runless.alreadySent?.[0]?.says)).toContain(`Already sent on run ${runId}`);

    await settle(FIRST, 'failed');
    const after = await deploy({ integrationId: bindingId });
    await work();
    expect(after).toMatchObject({ dispatched: true });
    expect(deployed).toHaveLength(2);
  });
});
