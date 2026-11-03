/**
 * ISS-827 — the env door on a project's Coolify binding, over HTTP against a throwaway Postgres and
 * a local Coolify: a holder of `deploys.run` lists the variable names of an application the binding
 * names (every value masked), sets one and deletes one; each write leaves an audit row naming the
 * key alone; `redeploy: true` queues the deploy act's own job for that one application. A value is
 * never answered, logged or stored by Forge: a planted value is searched for in every answer, every
 * delivery row and every log line this file causes.
 *
 * It reaches its subject over HTTP, so it names what it guards:
 * @direct-test-of packages/core/src/integration-door/coolify-env-routes.ts
 * @direct-test-of packages/core/src/integration-door/coolify-routes.ts
 * @direct-test-of packages/core/src/release-batch/coolify-env.ts
 * @direct-test-of packages/core/src/release-batch/coolify-controls.ts
 * @direct-test-of packages/core/src/integrations/deploy/coolify/client.ts
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { symbols } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OutboundDispatchJob } from '../../src/integrations/queue.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { registerAllIntegrations, seedDeployBinding } from '../helpers/release-world.js';

/** The value every write sends and the local Coolify answers back: it must surface nowhere. */
const SECRET = 'planted-env-secret-91c4e';

const WEB = { id: 't-web', label: 'web', resourceUuid: 'web-uuid' };
const CORE = { id: 't-core', label: 'core', resourceUuid: 'core-uuid' };
/** An application Coolify holds that no binding of the project names. */
const STRANGER_APP = 'other-project-app';
/** An application whose writes Coolify refuses, quoting the value it was sent. */
const REFUSING = { id: 't-refusing', label: 'refusing', resourceUuid: 'refusing-uuid' };

interface Held {
  uuid: string;
  value: string;
  isPreview: boolean;
}

/** Coolify: each application's variables, by key, and every request it was sent. */
const envs = new Map<string, Map<string, Held>>();
const calls: { method: string; path: string }[] = [];
const deployed: string[] = [];
let coolify: Server | null = null;
let seq = 0;

/** Every log line this file's requests cause. */
const logged: string[] = [];

let owner = '';
let adminToken = '';
let memberToken = '';
let strangerToken = '';
let bound = '';
let bindingId = '';
let unbound = '';
let twice = '';

const appEnvs = (app: string) => {
  const held = envs.get(app) ?? new Map<string, Held>();
  envs.set(app, held);
  return held;
};

function answerEnv(method: string, app: string, envUuid: string | undefined, body: Doc) {
  const held = appEnvs(app);
  if (app === REFUSING.resourceUuid && method !== 'GET') {
    return [422, { message: `the value ${String(body.value)} is not accepted` }] as const;
  }
  if (method === 'GET') {
    return [
      200,
      [...held].map(([key, e]) => ({
        uuid: e.uuid,
        key,
        value: e.value,
        real_value: e.value,
        is_preview: e.isPreview,
      })),
    ] as const;
  }
  if (method === 'DELETE') {
    const key = [...held].find(([, e]) => e.uuid === envUuid)?.[0];
    if (!key) return [404, { message: 'not found' }] as const;
    held.delete(key);
    return [200, { message: 'Environment variable deleted.' }] as const;
  }
  const key = String(body.key);
  const exists = held.has(key) && held.get(key)?.isPreview === false;
  if (method === 'POST' && exists) return [409, { message: 'already exists' }] as const;
  if (method === 'PATCH' && !exists) return [404, { message: 'not found' }] as const;
  seq += 1;
  const uuid = held.get(key)?.uuid ?? `env-${seq}`;
  held.set(key, { uuid, value: String(body.value), isPreview: false });
  return [201, { uuid }] as const;
}

beforeAll(async () => {
  testEnv();
  coolify = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      const url = new URL(String(req.url), 'http://coolify');
      const method = String(req.method);
      calls.push({ method, path: url.pathname });
      res.setHeader('content-type', 'application/json');
      const env = /^\/api\/v1\/applications\/([^/]+)\/envs(?:\/([^/]+))?$/.exec(url.pathname);
      if (env) {
        const [status, answer] = answerEnv(
          method,
          decodeURIComponent(env[1] ?? ''),
          env[2],
          raw ? (JSON.parse(raw) as Doc) : {},
        );
        res.statusCode = status;
        res.end(JSON.stringify(answer));
        return;
      }
      if (method === 'POST' && url.pathname === '/api/v1/deploy') {
        const uuid = url.searchParams.get('uuid') ?? '';
        deployed.push(uuid);
        res.end(JSON.stringify({ deployments: [{ deployment_uuid: `dep-${uuid}` }] }));
        return;
      }
      res.statusCode = 404;
      res.end('{"message":"not found"}');
    });
  });
  await new Promise<void>((done) => coolify?.listen(0, '127.0.0.1', done));
  const coolifyUrl = `http://127.0.0.1:${(coolify.address() as AddressInfo).port}`;

  await import('../../src/index.js');
  registerAllIntegrations();
  await startQueue();
  const { boss } = await import('../../src/queue/boss.js');
  const { INTEGRATIONS_QUEUE_NAME } = await import('../../src/queue/names.js');
  await boss.createQueue(INTEGRATIONS_QUEUE_NAME);

  // every line the process logs passes this one stream, a child logger's included; the test
  // process logs nothing by default, so every level is turned on and kept here, not printed
  const { logger } = await import('../../src/lib/logger.js');
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => unknown }>)[
    symbols.streamSym
  ];
  if (!stream) throw new Error('the logger exposes no stream to read its lines from');
  stream.write = (line: string) => logged.push(line);
  logger.level = 'trace';

  const admin = await createTestUser({ verified: true });
  owner = admin.id;
  adminToken = await userToken(admin.id);
  const member = await createTestUser({ verified: true });
  memberToken = await userToken(member.id);
  strangerToken = await userToken((await createTestUser({ verified: true })).id);

  const project = async () => {
    const { id } = await createTestProject(owner);
    await addProjectMember(id, owner, 'admin');
    await addProjectMember(id, member.id, 'member');
    return id;
  };
  bound = await project();
  bindingId = await seedDeployBinding(bound, owner, {
    baseUrl: coolifyUrl,
    targets: [WEB, CORE, REFUSING],
  });
  unbound = await project();
  twice = await project();
  await seedDeployBinding(twice, owner, { baseUrl: coolifyUrl, targets: [WEB] });
  await seedDeployBinding(twice, owner, { baseUrl: coolifyUrl, targets: [CORE] });
}, 120_000);

afterAll(async () => {
  await closeWorld();
  await new Promise<void>((done) => (coolify ? coolify.close(() => done()) : done()));
});

beforeEach(async () => {
  await rows(sql`DELETE FROM pgboss_v12.job WHERE name = 'forge.integrations'`);
  envs.clear();
  calls.length = 0;
  deployed.length = 0;
  appEnvs(WEB.resourceUuid).set('DATABASE_URL', {
    uuid: 'env-db',
    value: SECRET,
    isPreview: false,
  });
  appEnvs(WEB.resourceUuid).set('PREVIEW_ONLY', { uuid: 'env-pv', value: SECRET, isPreview: true });
  appEnvs(STRANGER_APP).set('THEIR_KEY', { uuid: 'env-x', value: SECRET, isPreview: false });
});

const env = (projectId: string, key?: string) =>
  `/api/projects/${projectId}/integrations/coolify/env${key ? `/${key}` : ''}`;

const answers: string[] = [];
async function call(
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  body?: Doc,
  token = adminToken,
) {
  const res = await api(token, method, path, body);
  answers.push(JSON.stringify(res.body));
  return { status: res.status, body: res.body as Doc };
}

const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);

const deliveries = () =>
  rows<{
    event_name: string;
    status: string;
    payload: Doc;
    response: Doc | null;
    error_message: string | null;
  }>(sql`
    SELECT event_name, status, payload, response, error_message FROM integration_deliveries
     WHERE binding_id = ${bindingId} AND event_name LIKE 'deploy.env.%' ORDER BY created_at`);

const queued = async () =>
  rows<{ data: OutboundDispatchJob }>(sql`
    SELECT data FROM pgboss_v12.job WHERE name = 'forge.integrations' ORDER BY created_on`);

describe('a holder of deploys.run (c1)', () => {
  it("lists the bound application's variable names, every value masked", async () => {
    const res = await call('GET', `${env(bound)}?resourceUuid=${WEB.resourceUuid}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      integrationId: bindingId,
      resourceUuid: WEB.resourceUuid,
      targetLabel: 'web',
      env: [
        { key: 'DATABASE_URL', value: '********', isPreview: false },
        { key: 'PREVIEW_ONLY', value: '********', isPreview: true },
      ],
    });
  });

  it('creates a key the application does not hold, then updates it, and deletes it', async () => {
    const created = await call('PUT', env(bound, 'API_TOKEN'), {
      resourceUuid: WEB.resourceUuid,
      value: SECRET,
    });
    expect([created.status, created.body.action, created.body.redeploy]).toEqual([
      200,
      'created',
      null,
    ]);
    expect(appEnvs(WEB.resourceUuid).get('API_TOKEN')?.value).toBe(SECRET);

    const updated = await call('PUT', env(bound, 'API_TOKEN'), {
      resourceUuid: WEB.resourceUuid,
      value: `${SECRET}-2`,
    });
    expect([updated.status, updated.body.action]).toEqual([200, 'updated']);
    expect(appEnvs(WEB.resourceUuid).get('API_TOKEN')?.value).toBe(`${SECRET}-2`);

    const deleted = await call('DELETE', env(bound, 'API_TOKEN'), {
      resourceUuid: WEB.resourceUuid,
    });
    expect([deleted.status, deleted.body.action]).toEqual([200, 'deleted']);
    expect(appEnvs(WEB.resourceUuid).has('API_TOKEN')).toBe(false);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([
      { method: 'POST', path: '/api/v1/applications/web-uuid/envs' },
      { method: 'PATCH', path: '/api/v1/applications/web-uuid/envs' },
      { method: 'DELETE', path: '/api/v1/applications/web-uuid/envs/env-1' },
    ]);
  });

  it('audits each write by key name alone (c3)', async () => {
    const before = (await deliveries()).length;
    await call('PUT', env(bound, 'AUDITED'), { resourceUuid: WEB.resourceUuid, value: SECRET });
    await call('DELETE', env(bound, 'AUDITED'), { resourceUuid: WEB.resourceUuid });
    const written = (await deliveries()).slice(before);
    expect(written.map((d) => [d.event_name, d.status, d.payload.keys, d.payload.actorId])).toEqual(
      [
        ['deploy.env.created', 'ok', ['AUDITED'], owner],
        ['deploy.env.deleted', 'ok', ['AUDITED'], owner],
      ],
    );
    expect(written.map((d) => d.response)).toEqual([{ keys: ['AUDITED'] }, { keys: ['AUDITED'] }]);
  });
});

describe('who may (c2)', () => {
  it('refuses a member without deploys.run and a stranger, before Coolify is asked', async () => {
    for (const token of [memberToken, strangerToken]) {
      const list = await call('GET', `${env(bound)}?resourceUuid=web-uuid`, undefined, token);
      const put = await call(
        'PUT',
        env(bound, 'K'),
        { resourceUuid: 'web-uuid', value: SECRET },
        token,
      );
      const del = await call(
        'DELETE',
        env(bound, 'DATABASE_URL'),
        { resourceUuid: 'web-uuid' },
        token,
      );
      expect([list.status, put.status, del.status]).toEqual([403, 403, 403]);
    }
    expect(calls).toEqual([]);
    expect(appEnvs(WEB.resourceUuid).has('K')).toBe(false);
  });
});

describe('refused by name (c4)', () => {
  it('a key on an application the binding does not name, reading and writing nothing there', async () => {
    const list = await call('GET', `${env(bound)}?resourceUuid=${STRANGER_APP}`);
    const put = await call('PUT', env(bound, 'THEIR_KEY'), {
      resourceUuid: STRANGER_APP,
      value: SECRET,
    });
    const del = await call('DELETE', env(bound, 'THEIR_KEY'), { resourceUuid: STRANGER_APP });
    for (const res of [list, put, del]) {
      expect([res.status, codes(res)]).toEqual([422, ['COOLIFY_TARGET_UNRESOLVED']]);
      expect(res.body.error?.refusals?.[0]?.detail).toContain(
        `resourceUuid ${STRANGER_APP} is not a deploy target of this integration`,
      );
    }
    expect(calls).toEqual([]);
    expect(appEnvs(STRANGER_APP).has('THEIR_KEY')).toBe(true);
  });

  it('a binding of several applications and no resourceUuid, naming them', async () => {
    const res = await call('GET', env(bound));
    expect(codes(res)).toEqual(['COOLIFY_TARGET_UNRESOLVED']);
    expect(res.body.error?.refusals?.[0]?.detail).toContain('web=web-uuid');
  });

  it('a project with no Coolify binding', async () => {
    const list = await call('GET', env(unbound));
    const put = await call('PUT', env(unbound, 'K'), { value: SECRET });
    for (const res of [list, put]) {
      expect(codes(res)).toEqual(['COOLIFY_INTEGRATION_UNRESOLVED']);
      expect(res.body.error?.refusals?.[0]?.detail).toContain('no active Coolify integration');
    }
  });

  it('a project with several Coolify bindings and no integrationId', async () => {
    const res = await call('PUT', env(twice, 'K'), { value: SECRET });
    expect(codes(res)).toEqual(['COOLIFY_INTEGRATION_UNRESOLVED']);
    expect(res.body.error?.refusals?.[0]?.detail).toContain('pass integrationId');
  });

  it('a delete of a key the application does not hold, naming the list to read', async () => {
    const res = await call('DELETE', env(bound, 'NEVER_SET'), { resourceUuid: WEB.resourceUuid });
    expect(codes(res)).toEqual(['COOLIFY_ENV_KEY_UNKNOWN']);
    expect(res.body.error?.refusals?.[0]?.detail).toContain('NEVER_SET');
  });

  it('a preview-only key, which the door neither updates nor deletes', async () => {
    const res = await call('DELETE', env(bound, 'PREVIEW_ONLY'), {
      resourceUuid: WEB.resourceUuid,
    });
    expect(codes(res)).toEqual(['COOLIFY_ENV_KEY_UNKNOWN']);
    expect(appEnvs(WEB.resourceUuid).get('PREVIEW_ONLY')?.isPreview).toBe(true);
  });

  it('a key that is not a variable name, and a value in the query', async () => {
    const bad = await call('PUT', env(bound, '1-BAD'), {
      resourceUuid: WEB.resourceUuid,
      value: 'x',
    });
    expect(bad.status).toBe(400);
    const extra = await call('GET', `${env(bound)}?resourceUuid=web-uuid&value=x`);
    expect(extra.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('redeploy (c5)', () => {
  it('queues the deploy act for the one application written to', async () => {
    const res = await call('PUT', env(bound, 'PROXY_HOPS'), {
      resourceUuid: CORE.resourceUuid,
      value: SECRET,
      redeploy: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.redeploy).toEqual({
      dispatched: true,
      pendingHumanConfirm: false,
      integrationIds: [bindingId],
    });
    const jobs = await queued();
    expect(
      jobs.map((j) => [j.data.jobKind, j.data.bindingId, j.data.payload?.targetLabels]),
    ).toEqual([['coolify.dispatch', bindingId, ['core']]]);
    // the job carries the deploy act's own records forward; no value rides on it
    expect(JSON.stringify(jobs)).not.toContain(SECRET);
  });

  it('queues nothing without it, and nothing when the write is refused', async () => {
    await call('PUT', env(bound, 'QUIET'), { resourceUuid: WEB.resourceUuid, value: SECRET });
    await call('PUT', env(bound, 'K'), {
      resourceUuid: STRANGER_APP,
      value: SECRET,
      redeploy: true,
    });
    expect(await queued()).toEqual([]);
  });
});

describe('a refused write (c3)', () => {
  it("names Coolify's status and route, never its answer quoting the value", async () => {
    const before = (await deliveries()).length;
    const res = await call('PUT', env(bound, 'REFUSED'), {
      resourceUuid: REFUSING.resourceUuid,
      value: SECRET,
      redeploy: true,
    });
    expect([res.status, codes(res)]).toEqual([424, ['COOLIFY_API_ERROR']]);
    const [row] = (await deliveries()).slice(before);
    expect([row?.event_name, row?.status, row?.error_message]).toEqual([
      'deploy.env.created',
      'failed',
      'Coolify answered HTTP 422 to POST /api/v1/applications/refusing-uuid/envs',
    ]);
    expect(await queued()).toEqual([]);
  });
});

// last, over everything the cases above answered, stored and logged
describe('the value (c3)', () => {
  it('is in no answer, no delivery row and no log line', async () => {
    expect(answers.length).toBeGreaterThan(20);
    expect(answers.filter((a) => a.includes(SECRET))).toEqual([]);
    const stored = await rows<Doc>(sql`
      SELECT payload, response, error_message FROM integration_deliveries WHERE binding_id = ${bindingId}`);
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    // the env requests themselves were logged, so the search below read their lines
    expect(logged.some((l) => l.includes('/integrations/coolify/env/'))).toBe(true);
    expect(logged.filter((l) => l.includes(SECRET))).toEqual([]);
  });
});
