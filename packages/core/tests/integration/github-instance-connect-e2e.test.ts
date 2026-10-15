/**
 * One public GitHub App serves the instance, only an operator makes it, and an installation of it is
 * recorded for an org only once GitHub shows it is the installer's (points 1, 2; S1, S2).
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const OPERATOR = 'operator@test.forge.local';
// env is read once, on first use: the operator list is set before anything imports it
vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'operator@test.forge.local';
});

import { INSTANCE_OWNER_ID, signConnectState } from '../../src/integrations/github/index.js';
import { api, userToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import {
  installations,
  installed,
  instanceApp,
  landing,
  OURS,
  record,
  STRANGERS,
  seedGithubWorld,
  stubGitHub,
} from '../helpers/github-instance-world.js';

let admin = '';
let session = '';
let project = { id: '', slug: '', orgId: '' };
let other = { id: '', slug: '', orgId: '' };

beforeAll(() => {
  testEnv();
});

beforeEach(async () => {
  await truncateAll();
  ({ admin, session, project, other } = await seedGithubWorld());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Connect GitHub goes to the one App, and only an operator makes it (points 1, 2)', () => {
  it('sends an org admin straight to the App’s install page once the App exists', async () => {
    stubGitHub();
    await instanceApp();

    const res = await api(session, 'POST', '/api/integration-connections/github/connect', {
      orgId: project.orgId,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.kind).toBe('install');
    const url = new URL(res.body.installUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://github.com/apps/forge-test-app/installations/new',
    );
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(res.body.manifest).toBeUndefined();
  });

  it('tells an org admin who is no operator to ask one, naming them, when the instance has no App', async () => {
    await createTestUser({ verified: true, email: OPERATOR });

    const res = await api(session, 'POST', '/api/integration-connections/github/connect', {
      orgId: project.orgId,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((res.body.error as { code: string }).code).toBe('GITHUB_APP_NOT_CONNECTED');
    expect(JSON.stringify(res.body)).toContain('Ask a Forge operator to connect GitHub');
    expect(JSON.stringify(res.body)).toContain(OPERATOR);
  });

  it('hands an operator the manifest of one public App that asks for OAuth on install, with no org field', async () => {
    const operator = (await createTestUser({ verified: true, email: OPERATOR })).id;
    await addProjectMember(project.id, operator, 'owner');
    await rows(sql`INSERT INTO organization_members (org_id, user_id, role)
      VALUES (${project.orgId}, ${operator}, 'admin') RETURNING org_id`);

    const res = await api(
      await userToken(operator),
      'POST',
      '/api/integration-connections/github/connect',
      { orgId: project.orgId },
      { 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'http' },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.kind).toBe('manifest');
    expect(res.body.postUrl).toBe('https://github.com/settings/apps/new');
    const manifest = res.body.manifest as Record<string, unknown>;
    expect(manifest.public).toBe(true);
    expect(manifest.request_oauth_on_install).toBe(true);
    expect(manifest.callback_urls).toEqual([
      'http://localhost:3000/api/integrations/github/installed',
    ]);
    expect((manifest.hook_attributes as { url: string }).url).toMatch(
      /\/api\/webhooks\/github\/app$/,
    );
    expect(String(manifest.name)).toBe('Forge — localhost:3000');

    const withOrg = await api(session, 'POST', '/api/integration-connections/github/connect', {
      orgId: project.orgId,
      org: 'SidCorp-co',
    });
    expect(withOrg.status, 'the org field is gone, and sending it is refused by name').toBe(400);
  });

  it('refuses an App that cannot prove an install yet, naming what it lacks', async () => {
    await instanceApp(false);

    const res = await api(session, 'POST', '/api/integration-connections/github/connect', {
      orgId: project.orgId,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((res.body.error as { code: string }).code).toBe('GITHUB_APP_INCOMPLETE');
    expect(JSON.stringify(res.body)).toContain('its client id, its client secret');
  });

  it('refuses a connect for an org the caller does not administer', async () => {
    await instanceApp();

    const res = await api(session, 'POST', '/api/integration-connections/github/connect', {
      orgId: other.orgId,
    });

    expect(res.status).toBe(403);
  });

  it('never makes a second App while one exists: the manifest’s return is stranded naming it', async () => {
    const asked = stubGitHub();
    await instanceApp();
    const operator = (await createTestUser({ verified: true, email: OPERATOR })).id;
    const state = signConnectState(process.env.JWT_SECRET as string, {
      userId: operator,
      orgId: project.orgId,
    });

    const where = landing(
      await api(
        await userToken(operator),
        'GET',
        `/api/integrations/github/manifest-callback?code=c0de&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(where.searchParams.get('connect')).toBe('app_exists');
    expect(where.searchParams.get('app')).toBe('forge-test-app');
    const [count] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM integration_connections WHERE provider = 'github'`,
    );
    expect(count?.n).toBe(1);
    expect(asked.filter((a) => a.includes('/app-manifests/')).length).toBe(1);
  });

  it('keeps the OAuth client of the App an operator makes, and goes on to its install page', async () => {
    stubGitHub();
    const operator = (await createTestUser({ verified: true, email: OPERATOR })).id;
    const state = signConnectState(process.env.JWT_SECRET as string, {
      userId: operator,
      orgId: project.orgId,
    });

    const where = landing(
      await api(
        await userToken(operator),
        'GET',
        `/api/integrations/github/manifest-callback?code=c0de&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(`${where.origin}${where.pathname}`).toBe(
      'https://github.com/apps/forge-test-app/installations/new',
    );
    const [row] = await rows<{ owner_type: string; owner_id: string; config: { appSlug: string } }>(
      sql`SELECT owner_type, owner_id, config FROM integration_connections`,
    );
    expect(row?.owner_type).toBe('instance');
    expect(row?.owner_id).toBe(INSTANCE_OWNER_ID);
    expect(row?.config.appSlug).toBe('forge-test-app');
  });

  it('strands a manifest return for anyone who is no operator, keeping nothing', async () => {
    stubGitHub();
    const state = signConnectState(process.env.JWT_SECRET as string, {
      userId: admin,
      orgId: project.orgId,
    });

    const where = landing(
      await api(
        session,
        'GET',
        `/api/integrations/github/manifest-callback?code=c0de&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(where.searchParams.get('connect')).toBe('not_operator');
    expect(await rows(sql`SELECT id FROM integration_connections`)).toEqual([]);
  });
});

describe('an installation is recorded only once GitHub shows it is the installer’s (S1)', () => {
  const stateFor = (orgId: string, userId = admin) =>
    encodeURIComponent(
      signConnectState(process.env.JWT_SECRET as string, {
        userId,
        orgId,
        returnTo: 'integrations',
      }),
    );

  it('records a proven installation for the org the state names and lands on Integrations to bind', async () => {
    stubGitHub();
    const connection = await instanceApp();

    const where = landing(
      await installed(
        session,
        `installation_id=${OURS}&code=oauth-code&state=${stateFor(project.orgId)}`,
      ),
    );

    expect(where.pathname).toBe('/integrations');
    expect(where.searchParams.get('bind')).toBe(connection);
    expect(await installations()).toEqual([
      { installation_id: String(OURS), org_id: project.orgId, proof: 'oauth', state: 'active' },
    ]);
  });

  it('PLANT: a forged installation_id on the person’s own genuine state is refused, and nothing is recorded', async () => {
    stubGitHub({ userInstallations: [OURS] });
    await instanceApp();

    const where = landing(
      await installed(
        session,
        `installation_id=${STRANGERS}&code=oauth-code&state=${stateFor(project.orgId)}`,
      ),
    );

    expect(where.searchParams.get('connect')).toBe('install_unproven');
    expect(await installations()).toEqual([]);
  });

  it('PLANT: an installation another org recorded is refused by name and never moved', async () => {
    stubGitHub();
    const connection = await instanceApp();
    await record(connection, OURS, other.orgId);

    const where = landing(
      await installed(
        session,
        `installation_id=${OURS}&code=oauth-code&state=${stateFor(project.orgId)}`,
      ),
    );

    expect(where.searchParams.get('connect')).toBe('install_claimed_elsewhere');
    expect((await installations())[0]?.org_id).toBe(other.orgId);
  });

  it('refuses an OAuth return that carries no state, recording nothing', async () => {
    stubGitHub();
    await instanceApp();

    const where = landing(await installed(session, `installation_id=${OURS}&code=oauth-code`));

    expect(where.searchParams.get('connect')).toBe('state_missing');
    expect(await installations()).toEqual([]);
  });
});
