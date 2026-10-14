/**
 * FB-128: a connection is added and bound into every project it serves in one call, from the
 * Integrations page or by an agent on the token door; one refusal writes nothing, the connection
 * included, and names the project and target. And GitHub's return never strands an App on a JSON
 * page: it lands on Integrations naming why, and spends the App's code to name it only when the
 * return is provably the person's own.
 */

import { randomUUID } from 'node:crypto';
import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { readConnectState, signConnectState } from '../../src/integrations/github/index.js';
import { api, userToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

let owner = '';
let session = '';
let first = { id: '', slug: '' };
let second = { id: '', slug: '' };

beforeAll(() => {
  testEnv();
});

beforeEach(async () => {
  await truncateAll();
  owner = (await createTestUser({ verified: true })).id;
  first = await createTestProject(owner);
  second = await createTestProject(owner);
  await addProjectMember(first.id, owner, 'owner');
  await addProjectMember(second.id, owner, 'owner');
  session = await userToken(owner);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const connections = () =>
  rows<{ id: string; provider: string }>(sql`SELECT id, provider FROM integration_connections`);
const bindingsOf = (projectId: string) =>
  rows<{ id: string; connection_id: string; active: boolean }>(
    sql`SELECT id, connection_id, active FROM integration_bindings WHERE project_id = ${projectId}`,
  );

const item = (projectId: string) => ({ projectId, role: 'service', target: { provider: 'agent' } });

describe('one call adds a connection and binds its projects (FB-128 BC-1, BC-3)', () => {
  it('binds every chosen project with the connection it creates', async () => {
    const res = await api(session, 'POST', '/api/integration-connections', {
      provider: 'agent',
      bindings: [item(first.id), item(second.id)],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [connection] = await connections();
    expect(connection?.provider).toBe('agent');
    for (const project of [first, second]) {
      const [binding] = await bindingsOf(project.id);
      expect(binding?.connection_id).toBe(connection?.id);
      expect(binding?.active).toBe(true);
    }
    expect((res.body.bindings as unknown[]).length).toBe(2);
  });

  it('writes nothing, the connection included, when one project is not the caller’s to administer', async () => {
    const stranger = (await createTestUser({ verified: true })).id;
    const theirs = await createTestProject(stranger);

    const res = await api(session, 'POST', '/api/integration-connections', {
      provider: 'agent',
      bindings: [item(first.id), item(theirs.id)],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const refusal = (
      res.body.error as { refusals: Array<{ code: string; path: string; detail: string }> }
    ).refusals[0];
    expect(refusal?.code).toBe('PROJECT_NOT_ADMINISTERED');
    expect(refusal?.path).toBe('/bindings/1/projectId');
    expect(refusal?.detail).toContain(theirs.id);
    expect(refusal?.detail).not.toContain(theirs.slug);
    expect(await connections()).toEqual([]);
    expect(await bindingsOf(first.id)).toEqual([]);
  });

  it('rolls the connection and the first binding back when a later binding’s slot is taken, naming its project and target', async () => {
    const held = await api(session, 'POST', '/api/integration-connections', {
      provider: 'agent',
      bindings: [item(second.id)],
    });
    expect(held.status, JSON.stringify(held.body)).toBe(201);

    const res = await api(session, 'POST', '/api/integration-connections', {
      provider: 'agent',
      bindings: [item(first.id), item(second.id)],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusal = (
      res.body.error as { refusals: Array<{ code: string; path: string; detail: string }> }
    ).refusals[0];
    expect(refusal?.code).toBe('BINDING_IN_USE');
    expect(refusal?.path.startsWith('/bindings/1')).toBe(true);
    expect(refusal?.detail).toContain(`project ${second.slug} (agent)`);
    expect((await connections()).length).toBe(1);
    expect(await bindingsOf(first.id)).toEqual([]);
  });

  it('binds an existing connection into several projects as one write', async () => {
    const created = await api(session, 'POST', '/api/integration-connections', {
      provider: 'agent',
    });
    const id = (created.body.connection as { id: string }).id;

    const res = await api(session, 'POST', `/api/integration-connections/${id}/bindings`, {
      bindings: [item(first.id), item(second.id)],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await bindingsOf(first.id))[0]?.connection_id).toBe(id);
    expect((await bindingsOf(second.id))[0]?.connection_id).toBe(id);
  });

  it('writes the switched-off binding holding a project’s slot again rather than refusing the slot, and says it did', async () => {
    const created = await api(session, 'POST', '/api/integration-connections', {
      provider: 'agent',
      bindings: [item(first.id)],
    });
    const [binding] = await bindingsOf(first.id);
    type Bound = { revision: number; rewroteSwitchedOff: unknown };
    const written = (created.body.bindings as Bound[])[0];
    expect(written?.rewroteSwitchedOff, 'a fresh slot rewrites nothing').toBeNull();
    const off = await api(session, 'DELETE', `/api/projects/${first.id}/bindings/${binding?.id}`, {
      baseRevision: written?.revision,
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const [switchedOff] = await rows<{ revision: number }>(
      sql`SELECT revision FROM integration_bindings WHERE id = ${binding?.id}`,
    );

    const again = await api(session, 'POST', '/api/integration-connections', {
      provider: 'agent',
      bindings: [item(first.id)],
    });

    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const after = await bindingsOf(first.id);
    expect(after.length).toBe(1);
    expect(after[0]?.id).toBe(binding?.id);
    expect(after[0]?.active).toBe(true);
    expect(
      (again.body.bindings as Bound[])[0]?.rewroteSwitchedOff,
      'the response names the switched-off binding it wrote over: an unreported normalization is a guess',
    ).toEqual({ revision: switchedOff?.revision, connection: binding?.connection_id });
  });

  it('leaves the binding document door writing one binding through the same checks', async () => {
    const created = await api(session, 'POST', '/api/integration-connections', {
      provider: 'agent',
    });
    const connection = (created.body.connection as { id: string }).id;
    const id = randomUUID();
    const document = {
      version: 1,
      id,
      role: 'service',
      connection,
      target: { provider: 'agent' },
    };

    const res = await api(session, 'PUT', `/api/projects/${first.id}/bindings/${id}`, {
      baseRevision: null,
      document: { ...document, $schema: `${SCHEMA_BASE}/binding-v1.json` },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await bindingsOf(first.id))[0]?.id).toBe(id);
  });

  it('refuses a targets read for a provider whose target is typed, by name', async () => {
    const created = await api(session, 'POST', '/api/integration-connections', {
      provider: 'agent',
    });
    const id = (created.body.connection as { id: string }).id;

    const res = await api(session, 'GET', `/api/integration-connections/${id}/targets`);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect((res.body.error as { code: string }).code).toBe('TARGETS_NOT_LISTED');
  });
});

describe('an agent adds and binds a connection through the same API in one call (FB-128 BC-6)', () => {
  it('takes the one call from an agent’s token, and refuses one fenced to projects by name', async () => {
    const agent = (await createTestUser({ kind: 'agent' })).id;
    await addProjectMember(first.id, agent, 'admin');
    await addProjectMember(second.id, agent, 'admin');
    const token = (
      await mintPat({
        permissions: ['*'],
        userId: agent,
        name: 'agent',
        grantEpoch: PAT_GRANT_EPOCH,
      })
    ).plaintext;

    const res = await api(token, 'POST', '/api/integration-connections', {
      provider: 'agent',
      bindings: [item(first.id), item(second.id)],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await bindingsOf(first.id)).length).toBe(1);
    expect((await bindingsOf(second.id)).length).toBe(1);

    const fenced = (
      await mintPat({
        permissions: ['*'],
        userId: agent,
        name: 'fenced',
        projectIds: [first.id],
        grantEpoch: PAT_GRANT_EPOCH,
      })
    ).plaintext;
    const refused = await api(fenced, 'POST', '/api/integration-connections', {
      provider: 'agent',
      bindings: [item(first.id)],
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
  });
});

// --- GitHub's return (FB-128 item 0) ---------------------------------------------------------

const SECRET = () => process.env.JWT_SECRET as string;
const HOUR = 60 * 60_000;

/** GitHub's manifest conversion, counted: every call that would spend an App's code. */
function stubGitHub(answer: 'ok' | 'gone' = 'ok') {
  const conversions: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/app-manifests/')) {
      conversions.push(url);
      if (answer === 'gone') return new Response('{"message":"Not Found"}', { status: 404 });
      return Response.json({
        id: 4242,
        slug: 'forge-test-app',
        pem: '-----BEGIN RSA PRIVATE KEY-----\nnot-a-key\n-----END RSA PRIVATE KEY-----',
        webhook_secret: 'whsec-test',
        html_url: 'https://github.com/apps/forge-test-app',
        owner: { login: 'SidCorp-co', type: 'Organization' },
      });
    }
    throw new Error(`unexpected fetch in test: ${init?.method ?? 'GET'} ${url}`);
  });
  return conversions;
}

const callback = (token: string | null, state: string) =>
  api(
    token,
    'GET',
    `/api/integrations/github/manifest-callback?code=c0de&state=${encodeURIComponent(state)}`,
  );

const landing = (res: { status: number; headers: Headers }) => {
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location') as string);
};

describe('GitHub’s return lands on Integrations, never on a JSON page (FB-128)', () => {
  it('keeps a state Forge signed genuine for the hour GitHub’s code lives', () => {
    const now = Date.now();
    const state = signConnectState(SECRET(), { projectId: first.id, userId: owner }, now);
    expect(readConnectState(SECRET(), state, now + 50 * 60_000).ok).toBe(true);
    expect(readConnectState(SECRET(), state, now + HOUR + 1)).toMatchObject({
      ok: false,
      why: 'expired',
    });
    expect(readConnectState(SECRET(), `${state}x`, now)).toEqual({ ok: false, why: 'invalid' });
  });

  it('stores the App and carries the state through the install, back to Integrations to bind', async () => {
    const conversions = stubGitHub();
    const state = signConnectState(SECRET(), {
      projectId: first.id,
      userId: owner,
      returnTo: 'integrations',
    });

    const res = await callback(session, state);

    expect(conversions.length).toBe(1);
    const install = landing(res);
    expect(
      install.href.startsWith('https://github.com/apps/forge-test-app/installations/new'),
    ).toBe(true);
    const [connection] = await connections();
    expect(connection?.provider).toBe('github');

    const installed = await api(
      session,
      'GET',
      `/api/integrations/github/installed?installation_id=77&state=${encodeURIComponent(install.searchParams.get('state') as string)}`,
    );
    const back = landing(installed);
    expect(back.pathname).toBe('/integrations');
    expect(back.searchParams.get('bind')).toBe(connection?.id);
  });

  describe('(ii) a return not provably the person’s own spends no code', () => {
    it('a forged state', async () => {
      const conversions = stubGitHub();
      const forged = `${signConnectState('another-secret-at-least-32-characters', { projectId: first.id, userId: owner })}`;

      const where = landing(await callback(session, forged));

      expect(where.pathname).toBe('/integrations');
      expect(where.searchParams.get('connect')).toBe('state_invalid');
      expect(where.searchParams.get('app')).toBeNull();
      expect(conversions).toEqual([]);
      expect(await connections()).toEqual([]);
    });

    it('another person’s state', async () => {
      const conversions = stubGitHub();
      const other = (await createTestUser({ verified: true })).id;
      const theirs = signConnectState(SECRET(), { projectId: first.id, userId: other });

      const where = landing(await callback(session, theirs));

      expect(where.searchParams.get('connect')).toBe('state_other_user');
      expect(conversions).toEqual([]);
    });

    it('no session at all', async () => {
      const conversions = stubGitHub();
      const state = signConnectState(SECRET(), { projectId: first.id, userId: owner });

      const where = landing(await callback(null, state));

      expect(where.pathname).toBe('/integrations');
      expect(where.searchParams.get('connect')).toBe('no_session');
      expect(conversions).toEqual([]);
    });
  });

  describe('(i) the person’s own genuine return names the App it strands, and keeps no key', () => {
    it('an expired state', async () => {
      const conversions = stubGitHub();
      const state = signConnectState(
        SECRET(),
        { projectId: first.id, userId: owner },
        Date.now() - HOUR - 1,
      );

      const where = landing(await callback(session, state));

      expect(where.searchParams.get('connect')).toBe('state_expired');
      expect(where.searchParams.get('app')).toBe('forge-test-app');
      expect(where.searchParams.get('appOwner')).toBe('SidCorp-co');
      expect(where.searchParams.get('appOrg')).toBe('1');
      expect(conversions.length).toBe(1);
      expect(await connections()).toEqual([]);
    });

    it('a project the person no longer administers', async () => {
      const conversions = stubGitHub();
      await db.execute(sql`DELETE FROM project_members WHERE project_id = ${first.id}`);
      await db.execute(sql`DELETE FROM organization_members WHERE user_id = ${owner}`);
      const state = signConnectState(SECRET(), { projectId: first.id, userId: owner });

      const where = landing(await callback(session, state));

      expect(where.searchParams.get('connect')).toBe('not_admin');
      expect(where.searchParams.get('app')).toBe('forge-test-app');
      expect(conversions.length).toBe(1);
      expect(await connections()).toEqual([]);
    });
  });

  it('names a conversion GitHub refuses, and stores nothing', async () => {
    stubGitHub('gone');
    const state = signConnectState(SECRET(), { projectId: first.id, userId: owner });

    const where = landing(await callback(session, state));

    expect(where.searchParams.get('connect')).toBe('conversion_failed');
    expect(await connections()).toEqual([]);
  });
});
