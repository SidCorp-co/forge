/**
 * What an org reaches of the instance's GitHub App is what was recorded for it: GitHub's own list of
 * the App's installations, every account's, is never read as a grant. A delivery is routed by the
 * installation and repository it names, and an App made before this keeps working exactly as it did
 * until an operator hands it to the instance (S1, S3, S4).
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const OPERATOR = 'operator@test.forge.local';
// env is read once, on first use: the operator list is set before anything imports it
vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'operator@test.forge.local';
});

import { INSTANCE_OWNER_ID } from '../../src/integrations/github/index.js';
import { createConnection } from '../../src/integrations/index.js';
import { api, userToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import {
  APP_ID,
  allDeliveries,
  bind,
  bindingIdOf,
  CLIENT_SECRET,
  deliver,
  deliveriesOf,
  installations,
  instanceApp,
  OURS,
  PRIVATE_KEY,
  record,
  STRANGERS,
  seedGithubWorld,
  stubGitHub,
  target,
  WEBHOOK_SECRET,
} from '../helpers/github-instance-world.js';

let admin = '';
let session = '';
let project = { id: '', slug: '', orgId: '' };
let other = { id: '', slug: '', orgId: '' };
let otherSession = '';

beforeAll(() => {
  testEnv();
});

beforeEach(async () => {
  await truncateAll();
  ({ admin, session, project, other, otherSession } = await seedGithubWorld());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('targets and bindings reach only what was recorded for the caller’s org (S1)', () => {
  it('PLANT: /targets lists the recorded installation’s repositories and never an unrecorded one, never asking GitHub for every installation', async () => {
    const asked = stubGitHub();
    const connection = await instanceApp();
    await record(connection, OURS, project.orgId);

    const res = await api(session, 'GET', `/api/integration-connections/${connection}/targets`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const targets = res.body.targets as Array<{ installationId: number; owner: string }>;
    expect(targets.map((t) => t.installationId)).toEqual([OURS]);
    expect(asked.some((a) => a.endsWith('/app/installations'))).toBe(false);

    const theirs = await api(
      otherSession,
      'GET',
      `/api/integration-connections/${connection}/targets`,
    );
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    expect(theirs.body.targets, 'another org reaches nothing it did not record').toEqual([]);
  });

  it('binds a recorded installation’s repository into a project of its org', async () => {
    stubGitHub();
    const connection = await instanceApp();
    await record(connection, OURS, project.orgId);

    const res = await bind(session, connection, project.id, OURS);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await bindingIdOf(project.id)).toBeTruthy();
  });

  it('PLANT: POST /bindings with an unrecorded installationId is refused by name, and nothing is written', async () => {
    stubGitHub();
    const connection = await instanceApp();

    const res = await bind(session, connection, project.id, STRANGERS);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(JSON.stringify(res.body)).toContain('GITHUB_INSTALLATION_NOT_RECORDED');
    expect(JSON.stringify(res.body)).toContain(`installation ${STRANGERS}`);
    expect(await bindingIdOf(project.id)).toBeUndefined();
  });

  it('refuses binding an installation recorded for another org', async () => {
    stubGitHub();
    const connection = await instanceApp();
    await record(connection, OURS, other.orgId);

    const res = await bind(session, connection, project.id, OURS);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(JSON.stringify(res.body)).toContain('recorded for another Forge organisation');
  });

  it('PLANT: shows another org none of the App’s bindings in this org, in the directory or its bindings list', async () => {
    stubGitHub();
    const connection = await instanceApp();
    await record(connection, OURS, project.orgId);
    expect((await bind(session, connection, project.id, OURS)).status).toBe(200);

    const directory = await api(otherSession, 'GET', '/api/integration-connections');
    const listed = await api(
      otherSession,
      'GET',
      `/api/integration-connections/${connection}/bindings`,
    );
    const own = await api(session, 'GET', `/api/integration-connections/${connection}/bindings`);

    type Row = { id: string; usage: { bindings: Array<{ projectId: string }> } };
    const row = (directory.body.items as Row[]).find((r) => r.id === connection);
    expect(row, 'every org sees the instance’s App itself').toBeTruthy();
    expect(row?.usage.bindings).toEqual([]);
    expect(listed.body.items).toEqual([]);
    expect((own.body.items as Array<{ projectId: string }>).map((b) => b.projectId)).toEqual([
      project.id,
    ]);
    expect(JSON.stringify(directory.body)).not.toContain(project.id);
  });

  it('lets nobody but an operator change or remove the instance’s App', async () => {
    const connection = await instanceApp();

    const patched = await api(session, 'PATCH', `/api/integration-connections/${connection}`, {
      displayName: 'mine now',
    });
    const removed = await api(session, 'DELETE', `/api/integration-connections/${connection}`);

    expect(patched.status).toBe(403);
    expect(removed.status).toBe(403);
    const [row] = await rows<{ active: boolean; display_name: string }>(
      sql`SELECT active, display_name FROM integration_connections WHERE id = ${connection}`,
    );
    expect(row).toEqual({ active: true, display_name: 'GitHub App forge-test-app' });
  });
});

describe('a delivery is routed by the installation and repository it names (S4)', () => {
  async function boundWorld() {
    stubGitHub();
    const connection = await instanceApp();
    await record(connection, OURS, project.orgId);
    const res = await bind(session, connection, project.id, OURS);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { connection, binding: await bindingIdOf(project.id) };
  }

  const issueEvent = (installationId: number, repository = 'SidCorp-co/forge') => ({
    action: 'opened',
    installation: { id: installationId },
    repository: { full_name: repository },
  });

  it('routes an App-wide delivery to the binding of its installation and repository', async () => {
    const { binding } = await boundWorld();

    const res = await deliver('/api/webhooks/github/app', 'issues', issueEvent(OURS));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.kind).toBe('routed');
    expect(await deliveriesOf(binding)).toEqual([{ status: 'ok', event_name: 'issues.opened' }]);
  });

  it('refuses a delivery the App’s secret does not sign before routing anything', async () => {
    const { binding } = await boundWorld();

    const res = await deliver(
      '/api/webhooks/github/app',
      'issues',
      issueEvent(OURS),
      'not-the-secret',
    );

    expect(res.status).toBe(401);
    expect((await deliveriesOf(binding)).filter((d) => d.status !== 'refused')).toEqual([]);
  });

  it('PLANT: drops a delivery from an installation nothing binds, writing nothing', async () => {
    await boundWorld();
    const before = (await allDeliveries()).length;

    const res = await deliver(
      '/api/webhooks/github/app',
      'issues',
      issueEvent(STRANGERS, 'someone-else/forge'),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'dropped',
      reason: 'no binding uses this installation and repository',
    });
    expect((await allDeliveries()).length).toBe(before);
  });

  it('routes the same way when the App’s hook still points at a project’s slug door', async () => {
    const { connection, binding } = await boundWorld();
    const otherAdmin = (await createTestUser({ verified: true })).id;
    const second = await createTestProject(otherAdmin, { orgId: project.orgId });
    await addProjectMember(second.id, admin, 'owner');
    const res2 = await api(session, 'POST', `/api/integration-connections/${connection}/bindings`, {
      bindings: [
        { projectId: second.id, role: 'service', target: { ...target(OURS), repo: 'web' } },
      ],
    });
    expect(res2.status, JSON.stringify(res2.body)).toBe(200);
    const secondBinding = await bindingIdOf(second.id);

    const res = await deliver(
      `/api/webhooks/in/${project.slug}`,
      'issues',
      issueEvent(OURS, 'SidCorp-co/web'),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await deliveriesOf(secondBinding)).toEqual([
      { status: 'ok', event_name: 'issues.opened' },
    ]);
    expect(await deliveriesOf(binding)).toEqual([]);
  });

  it('marks a removed installation gone, and its binding reads degraded naming why, never deleted', async () => {
    const { binding } = await boundWorld();

    const res = await deliver('/api/webhooks/github/app', 'installation', {
      action: 'deleted',
      installation: { id: OURS, account: { login: 'SidCorp-co' } },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await installations())[0]?.state).toBe('gone');
    const list = await api(session, 'GET', `/api/projects/${project.id}/integrations`);
    const item = (
      list.body.items as Array<{ id: string; lastHealthStatus: string; lastHealthDetail: string }>
    ).find((i) => i.id === binding);
    expect(item?.lastHealthStatus).toBe('degraded');
    expect(item?.lastHealthDetail).toContain('the App was removed from SidCorp-co on GitHub');
  });

  it('suspends and unsuspends, and a repository taken off the installation reads degraded naming it', async () => {
    const { binding } = await boundWorld();
    await deliver('/api/webhooks/github/app', 'installation', {
      action: 'suspend',
      installation: { id: OURS },
    });
    expect((await installations())[0]?.state).toBe('suspended');
    await deliver('/api/webhooks/github/app', 'installation', {
      action: 'unsuspend',
      installation: { id: OURS },
    });
    expect((await installations())[0]?.state).toBe('active');

    await deliver('/api/webhooks/github/app', 'installation_repositories', {
      action: 'removed',
      installation: { id: OURS },
      repositories_removed: [{ full_name: 'SidCorp-co/forge' }],
    });

    const list = await api(session, 'GET', `/api/projects/${project.id}/integrations`);
    const item = (
      list.body.items as Array<{ id: string; lastHealthStatus: string; lastHealthDetail: string }>
    ).find((i) => i.id === binding);
    expect(item?.lastHealthStatus).toBe('degraded');
    expect(item?.lastHealthDetail).toContain('SidCorp-co/forge was taken off');

    await deliver('/api/webhooks/github/app', 'installation_repositories', {
      action: 'added',
      installation: { id: OURS },
      repositories_added: [{ full_name: 'SidCorp-co/forge' }],
    });
    const again = await api(session, 'GET', `/api/projects/${project.id}/integrations`);
    const back = (again.body.items as Array<{ id: string; lastHealthStatus: string | null }>).find(
      (i) => i.id === binding,
    );
    expect(back?.lastHealthStatus).not.toBe('degraded');
  });
});

describe('an App made before this keeps working until an operator completes it (S3)', () => {
  /** The App as forge-dev holds fea7dc5e: org-owned, bound to SidCorp-co/forge on its own installation. */
  async function grandfathered() {
    stubGitHub();
    const row = await createConnection({
      ownerType: 'org',
      ownerId: project.orgId,
      provider: 'github',
      displayName: 'GitHub App forge-dev-env',
      config: {},
      secrets: { appId: APP_ID, privateKey: PRIVATE_KEY, webhookSecret: WEBHOOK_SECRET },
    });
    const res = await bind(session, row.id, project.id, 171606736);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { connection: row.id, binding: await bindingIdOf(project.id) };
  }

  it('PLANT: the grandfathered binding 171606736 → SidCorp-co/forge works exactly as now at its slug door', async () => {
    const { binding } = await grandfathered();

    const ok = await deliver(`/api/webhooks/in/${project.slug}`, 'issues', {
      action: 'opened',
      installation: { id: 171606736 },
      repository: { full_name: 'SidCorp-co/forge' },
    });
    const foreign = await deliver(`/api/webhooks/in/${project.slug}`, 'issues', {
      action: 'opened',
      installation: { id: 171606736 },
      repository: { full_name: 'SidCorp-co/web' },
    });

    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ accepted: true, handler: 'github', role: 'service' });
    expect(foreign.status).toBe(422);
    expect(JSON.stringify(foreign.body)).toContain('WEBHOOK_FOREIGN_REPOSITORY');
    expect(await deliveriesOf(binding)).toEqual(
      expect.arrayContaining([
        { status: 'ok', event_name: 'issues.opened' },
        { status: 'refused', event_name: 'issues.opened' },
      ]),
    );
    expect(await installations()).toEqual([]);
  });

  it('refuses completing it to anyone but an operator', async () => {
    const { connection } = await grandfathered();

    const res = await api(
      session,
      'POST',
      `/api/integration-connections/${connection}/github-app/complete`,
      {
        clientSecret: CLIENT_SECRET,
      },
    );

    expect(res.status).toBe(403);
    expect((res.body.error as { code: string }).code).toBe('GITHUB_APP_OPERATOR_ONLY');
  });

  it('refuses a client secret GitHub does not take, changing nothing', async () => {
    const { connection } = await grandfathered();
    stubGitHub({ clientSecretHolds: false });
    const operator = (await createTestUser({ verified: true, email: OPERATOR })).id;

    const res = await api(
      await userToken(operator),
      'POST',
      `/api/integration-connections/${connection}/github-app/complete`,
      { clientSecret: 'not-the-secret' },
    );

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('does not take this client secret');
    const [row] = await rows<{ owner_type: string }>(
      sql`SELECT owner_type FROM integration_connections WHERE id = ${connection}`,
    );
    expect(row?.owner_type).toBe('org');
  });

  it('hands it to the instance, recording the installation its binding holds for that project’s org', async () => {
    const { connection, binding } = await grandfathered();
    const operator = (await createTestUser({ verified: true, email: OPERATOR })).id;

    const res = await api(
      await userToken(operator),
      'POST',
      `/api/integration-connections/${connection}/github-app/complete`,
      { clientSecret: CLIENT_SECRET },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await rows<{
      owner_type: string;
      owner_id: string;
      config: Record<string, unknown>;
    }>(
      sql`SELECT owner_type, owner_id, config FROM integration_connections WHERE id = ${connection}`,
    );
    expect(row?.owner_type).toBe('instance');
    expect(row?.owner_id).toBe(INSTANCE_OWNER_ID);
    expect(row?.config).toMatchObject({ appSlug: 'forge-dev-env', appOwner: 'SidCorp-co' });
    expect(await installations()).toEqual([
      {
        installation_id: '171606736',
        org_id: project.orgId,
        proof: 'bound_before',
        state: 'active',
      },
    ]);

    const ok = await deliver(`/api/webhooks/in/${project.slug}`, 'issues', {
      action: 'opened',
      installation: { id: 171606736 },
      repository: { full_name: 'SidCorp-co/forge' },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await deliveriesOf(binding)).toEqual([{ status: 'ok', event_name: 'issues.opened' }]);
  });
});
