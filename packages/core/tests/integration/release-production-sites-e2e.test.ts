/**
 * ISS-1077 (sidcorp-mail 0.16.0, 2026-11-07): one product ships to two production sites from one
 * branch, mail.sidcorp.co and webmail.lighthuman.vn, each through its own Coolify binding. The project
 * document could name only one, so the release deployed one site, skipped the other in silence and
 * read as shipped while webmail.lighthuman.vn still served the old build. Through the app's own doors,
 * with Coolify stubbed (`http://coolify.invalid`, no deploy leaves the process): a release deploys every
 * site, each parking on its own confirm; a site it did not reach reads as not shipped by its name and
 * holds the release from shipping; and a release whose record names every site ships, each site with
 * what it serves.
 *
 * @direct-test-of packages/core/src/release-batch/release-sites.ts
 * @direct-test-of packages/core/src/release-batch/finish-job.ts
 * @direct-test-of packages/core/src/release-batch/release-coolify.ts
 * @direct-test-of packages/core/src/release-batch/gate.ts
 * @direct-test-of packages/core/src/release-batch/channel.ts
 * @direct-test-of packages/core/src/release-batch/release-read-views.ts
 * @direct-test-of packages/core/src/project-config/environment-state-routes.ts
 * @direct-test-of packages/core/src/integrations/deploy/coolify/deployment-records.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
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
  fakeCoolify,
  registerAllIntegrations,
  releaseWorld,
  seedDeployBinding,
  seedProjectDocument,
} from '../helpers/release-world.js';

const COMMIT = 'de7ccf81'.padEnd(40, '0');

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'github',
    fullName: 'acme/sidcorp-mail',
    branchHead: async () => COMMIT,
  }),
}));

let projectId = '';
let ownerId = '';
let token = '';
let mail = '';
let webmail = '';
const fx = releaseWorld(() => ({ projectId, ownerId }));
const records = fakeCoolify();

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
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  const coolify = (app: string) => ({
    baseUrl: 'http://coolify.invalid',
    targets: [{ id: `t-${app}`, label: app, resourceUuid: `${app}-uuid` }],
  });
  mail = await seedDeployBinding(projectId, ownerId, coolify('mail'));
  webmail = await seedDeployBinding(projectId, ownerId, coolify('webmail'));
  // production is two sites: its own deployment (mail.sidcorp.co) and `webmail`, each on request
  await seedProjectDocument(projectId, ownerId, {
    defaultBranch: 'main',
    promotions: [{ from: 'main', to: 'production', via: 'merge' }],
    environments: {
      live: {
        tier: 'production',
        deploysFrom: 'production',
        deployment: { binding: mail, trigger: 'on-request' },
        url: 'https://mail.example.test',
        sites: [
          {
            name: 'webmail',
            deployment: { binding: webmail, trigger: 'on-request' },
            url: 'https://webmail.example.test',
          },
        ],
      },
    },
  });
  await fx.seedReleaseRunner();
});

type Doc = Record<string, unknown>;
type Site = { name: string; state: string; serves: string | null; url: string | null };

const send = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const res = await send(method, path, body);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as Doc;
};

async function cut(): Promise<{ runId: string; version: string; issueId: string }> {
  const issueId = await fx.insertIssue();
  const { runId, version } = await fx.claim([issueId]);
  return { runId, version: String(version), issueId };
}

const deploy = (runId: string) =>
  call('POST', '/integrations/coolify/deploy', { pipelineRunId: runId });
const confirm = (bindingId: string) =>
  call('POST', `/integrations/${bindingId}/confirm-prod-deploy`, {});

async function release(version: string): Promise<Doc & { state: string; sites: Site[] }> {
  return (await call('GET', `/releases/${version}`)).release as Doc & {
    state: string;
    sites: Site[];
  };
}
const statesOf = (sites: Site[]) => sites.map((s) => [s.name, s.state]);

async function refusedFinish(runId: string, body: Doc = {}) {
  const res = await send('POST', `/release-batches/${runId}/finish`, body);
  return { status: res.status, body: JSON.stringify(res.body) };
}

describe('a release over a production of two sites (ISS-1077)', () => {
  it('deploys every site, each parking on its own confirm, and reads each by name', async () => {
    const { runId, version } = await cut();

    const answer = await deploy(runId);

    expect(answer).toMatchObject({ pendingHumanConfirm: true, reason: 'awaiting-prod-confirm' });
    expect(new Set(answer.integrationIds as string[])).toEqual(new Set([mail, webmail]));
    for (const b of [mail, webmail]) {
      expect(String(answer.waitsOn)).toContain(`/integrations/${b}/confirm-prod-deploy`);
    }
    const [run] = await rows<{ gate: Doc | null }>(sql`
      SELECT metadata->'__forge_prod_deploy_gate' AS gate FROM pipeline_runs WHERE id = ${runId}`);
    expect(Object.keys(run?.gate ?? {}).sort()).toEqual([mail, webmail].sort());

    const read = await release(version);
    expect(statesOf(read.sites)).toEqual([
      ['live', 'awaiting_confirm'],
      ['webmail', 'awaiting_confirm'],
    ]);
    expect(read.sites[1]?.url).toBe('https://webmail.example.test');
  });

  it('holds as not shipped while a site still asks for its confirm, naming that site', async () => {
    const { runId, version, issueId } = await cut();
    await deploy(runId);
    await confirm(mail);

    expect(statesOf((await release(version)).sites)).toEqual([
      ['live', 'deploying'],
      ['webmail', 'awaiting_confirm'],
    ]);

    const bare = await refusedFinish(runId);
    expect(bare.status).toBe(409);
    expect(bare.body).toContain('RELEASE_SITE_NOT_SHIPPED');
    expect(bare.body).toContain('`webmail`');
    // naming the site is not shipping it: its deploy never left, waiting on the confirm
    const claimed = await refusedFinish(runId, {
      sites: [
        { name: 'live', serves: version },
        { name: 'webmail', serves: version },
      ],
    });
    expect(claimed.status).toBe(409);
    expect(claimed.body).toContain("`webmail` (its deploy waits on a person's confirm");

    expect((await release(version)).state).toBe('in_progress');
    expect(await fx.stored(issueId)).toMatchObject({ status: 'awaiting_release' });
  });

  it('reads a site whose deploy failed as failed, and never ships over it', async () => {
    const { runId, version, issueId } = await cut();
    await deploy(runId);
    await confirm(mail);
    await confirm(webmail);
    // the deploy this run sent to webmail settles failed
    await db.execute(sql`
      UPDATE pipeline_runs
         SET metadata = jsonb_set(metadata, '{__forge_deploy_confirm}', (
               SELECT jsonb_object_agg(k, CASE WHEN v->>'bindingId' = ${webmail}
                                               THEN v || '{"status":"failed"}'::jsonb ELSE v END)
                 FROM jsonb_each(metadata->'__forge_deploy_confirm') AS e(k, v)))
       WHERE id = ${runId}`);

    expect(statesOf((await release(version)).sites)).toEqual([
      ['live', 'deploying'],
      ['webmail', 'failed'],
    ]);
    const refused = await refusedFinish(runId, { sites: [{ name: 'live', serves: version }] });
    expect(refused.status).toBe(409);
    expect(refused.body).toContain('`webmail` (the deploy this run sent it failed)');
    expect((await release(version)).state).toBe('in_progress');
    expect(await fx.stored(issueId)).toMatchObject({ status: 'awaiting_release' });
  });

  it('refuses a record naming a site production does not declare', async () => {
    const { runId, version } = await cut();
    const refused = await refusedFinish(runId, {
      sites: [
        { name: 'live', serves: version },
        { name: 'webmail', serves: version },
        { name: 'catalog', serves: version },
      ],
    });
    expect(refused.body).toContain('RELEASE_SITE_UNDECLARED');
    expect(refused.body).toContain('`catalog`');
  });

  it('ships once its record names every site, each with what it serves', async () => {
    const { runId, version, issueId } = await cut();
    await deploy(runId);
    await confirm(mail);
    await confirm(webmail);

    await call('POST', `/release-batches/${runId}/finish`, {
      sites: [
        { name: 'live', serves: version },
        { name: 'webmail', serves: COMMIT },
      ],
    });
    // the door wrote the record; the finish job's work is done here, in-process, on its record
    const { finishReleaseBatch } = await import('../../src/release-batch/finish.js');
    await finishReleaseBatch(runId, { type: 'user', id: ownerId, agency: 'agent' });

    expect((await release(version)).state).toBe('shipped');
    expect((await release(version)).sites).toEqual([
      { name: 'live', state: 'shipped', serves: version, url: 'https://mail.example.test' },
      { name: 'webmail', state: 'shipped', serves: COMMIT, url: 'https://webmail.example.test' },
    ]);
    expect(await fx.stored(issueId)).toMatchObject({ status: 'closed' });
  });

  it('a production of one site still ships on the finish body a release job sends today', async () => {
    // the release-flow skill ships on its own clock: `{}` and `{ commit }` must keep finishing
    await seedProjectDocument(projectId, ownerId, {
      defaultBranch: 'main',
      promotions: [{ from: 'main', to: 'production', via: 'merge' }],
      environments: {
        live: {
          tier: 'production',
          deploysFrom: 'production',
          deployment: { binding: mail, trigger: 'on-request' },
          url: 'https://mail.example.test',
        },
      },
    });
    const { runId, version, issueId } = await cut();

    await call('POST', `/release-batches/${runId}/finish`, { commit: COMMIT });
    const { finishReleaseBatch } = await import('../../src/release-batch/finish.js');
    await finishReleaseBatch(runId, { type: 'user', id: ownerId, agency: 'agent' });

    const read = await release(version);
    expect(read.state).toBe('shipped');
    expect(read.sites).toEqual([
      { name: 'live', state: 'shipped', serves: COMMIT, url: 'https://mail.example.test' },
    ]);
    expect(await fx.stored(issueId)).toMatchObject({ status: 'closed' });
  });

  it('a release recorded by hand over two sites names each, or is refused by the one it leaves out', async () => {
    const issueId = await fx.insertIssue();
    const body = {
      issueIds: [issueId],
      version: '1.4.0',
      account: 'deployed both sites through the integration and watched each come up',
    };
    const refused = await send('POST', '/release-records', body);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('RELEASE_SITE_NOT_SHIPPED');
    expect(await fx.stored(issueId)).toMatchObject({ status: 'awaiting_release' });

    await call('POST', '/release-records', {
      ...body,
      sites: [
        { name: 'live', serves: '1.4.0' },
        { name: 'webmail', serves: '1.4.0' },
      ],
    });
    expect(statesOf((await release('1.4.0')).sites)).toEqual([
      ['live', 'shipped'],
      ['webmail', 'shipped'],
    ]);
    expect(await fx.stored(issueId)).toMatchObject({ status: 'closed' });
  });

  it('reads each site’s deployment record off its own application, by the site’s name', async () => {
    const served = 'ab12cd34'.padEnd(40, '0');
    // the record read goes to a Coolify answering over HTTP in this process, never a real one
    await db.execute(sql`
      UPDATE integration_bindings
         SET config = jsonb_set(config, '{baseUrl}', to_jsonb(${records.url()}::text))
       WHERE project_id = ${projectId}`);
    records.deployed('mail-uuid', 'dep-mail', COMMIT, '2026-11-07T10:00:00Z');
    records.deployed('webmail-uuid', 'dep-webmail', served, '2026-11-07T11:00:00Z');

    const list = (await call('GET', '/environments/state')).environments as Doc[];
    expect(list.map((e) => [e.environment, (e.source as Doc | undefined)?.revision])).toEqual([
      ['live', COMMIT],
      ['webmail', served],
    ]);
    const one = await call('GET', '/environments/webmail/state');
    expect(one).toMatchObject({
      environment: 'webmail',
      deployment: { id: 'dep-webmail' },
      source: { revision: served },
    });
  });
});

// ISS-1139: catalog-api's cnw and lsm deploy outside Forge, through forge-ops, and could not be
// declared, so a release read as shipped without saying either site's state. Planted with production
// deployed outside Forge by forge-ops, as two sites, each read by its own runtime verification.
describe('a production whose sites are deployed outside Forge (ISS-1139)', () => {
  const probe = (host: string) => ({
    runtime: [
      {
        type: 'http' as const,
        url: `https://${host}/version`,
        path: 'commit',
        identifies: 'source' as const,
      },
    ],
  });
  const external = { mode: 'external' as const, target: 'forge-ops' };

  beforeEach(async () => {
    await seedProjectDocument(projectId, ownerId, {
      defaultBranch: 'main',
      environments: {
        cnw: {
          tier: 'production',
          deploysFrom: 'main',
          deployment: external,
          url: 'https://cnw.example.test',
          verification: probe('cnw.example.test'),
          sites: [
            {
              name: 'lsm',
              deployment: external,
              url: 'https://lsm.example.test',
              verification: probe('lsm.example.test'),
            },
          ],
        },
      },
    });
  });

  it('refuses a record leaving a site out, naming it as deployed outside Forge, then ships naming each', async () => {
    const issueId = await fx.insertIssue();
    const body = {
      issueIds: [issueId],
      version: '2.1.0',
      account: 'forge-ops deployed both sites; each version endpoint read the release commit',
    };
    const refused = await send('POST', '/release-records', {
      ...body,
      sites: [{ name: 'cnw', serves: COMMIT }],
    });
    expect(refused.status).toBe(409);
    const said = JSON.stringify(refused.body);
    expect(said).toContain('RELEASE_SITE_NOT_SHIPPED');
    expect(said).toContain('`lsm` (deployed outside Forge, and your record does not name it');
    expect(await fx.stored(issueId)).toMatchObject({ status: 'awaiting_release' });

    await call('POST', '/release-records', {
      ...body,
      sites: [
        { name: 'cnw', serves: COMMIT },
        { name: 'lsm', serves: COMMIT },
      ],
    });
    expect((await release('2.1.0')).sites).toEqual([
      { name: 'cnw', state: 'shipped', serves: COMMIT, url: 'https://cnw.example.test' },
      { name: 'lsm', state: 'shipped', serves: COMMIT, url: 'https://lsm.example.test' },
    ]);
    expect(await fx.stored(issueId)).toMatchObject({ status: 'closed' });
  });
});
