/**
 * The world the instance GitHub App's e2e files share: GitHub as the App sees it, the App itself,
 * an installation recorded for an org, and a delivery signed as GitHub signs one.
 */

import { createHmac, generateKeyPairSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { app } from '../../src/index.js';
import { INSTANCE_OWNER_ID } from '../../src/integrations/github/index.js';
import { createConnection } from '../../src/integrations/index.js';
import { api, userToken } from './api.js';
import { addProjectMember, createTestProject, createTestUser, rows } from './factories.js';

/** An org admin with a project, and a stranger with a project of another org. */
export async function seedGithubWorld() {
  const admin = (await createTestUser({ verified: true })).id;
  const project = await createTestProject(admin);
  await addProjectMember(project.id, admin, 'owner');
  const stranger = (await createTestUser({ verified: true })).id;
  const other = await createTestProject(stranger);
  await addProjectMember(other.id, stranger, 'owner');
  return {
    admin,
    session: await userToken(admin),
    project,
    other,
    otherSession: await userToken(stranger),
  };
}

export const APP_ID = '4242';
export const CLIENT_ID = 'Iv1.instanceapp';
export const CLIENT_SECRET = 'client-secret-of-the-app';
export const WEBHOOK_SECRET = 'whsec-the-instance-app';
export const OURS = 77;
export const STRANGERS = 99;
export const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** GitHub as the App sees it: what each route answers, and every URL asked. */
export function stubGitHub(
  opts: {
    userInstallations?: number[];
    clientSecretHolds?: boolean;
    /** How GitHub answers an unauthenticated read of the App: 200 public, 404 private. */
    appPage?: number;
  } = {},
) {
  const asked: string[] = [];
  const listed = opts.userInstallations ?? [OURS];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
    asked.push(`${method} ${url}`);
    const path = new URL(url).pathname;
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return Response.json({ access_token: 'ghu_the_installer', token_type: 'bearer' });
    }
    if (path === '/user/installations') {
      return Response.json({
        total_count: listed.length,
        installations: listed.map((id) => ({
          id,
          app_id: Number(APP_ID),
          account: { login: id === OURS ? 'SidCorp-co' : 'someone-else', type: 'Organization' },
        })),
      });
    }
    if (path === '/app/installations') {
      return Response.json([
        { id: OURS, account: { login: 'SidCorp-co' } },
        { id: STRANGERS, account: { login: 'someone-else' } },
      ]);
    }
    const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint) {
      return Response.json(
        { token: `ghs_${mint[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
        { status: 201 },
      );
    }
    const one = path.match(/^\/app\/installations\/(\d+)$/);
    if (one) {
      return Response.json({
        id: Number(one[1]),
        account: { login: 'SidCorp-co', type: 'Organization' },
      });
    }
    if (path === '/installation/repositories') {
      const token = new Headers(init?.headers).get('authorization') ?? '';
      const inst = token.includes(String(STRANGERS)) ? STRANGERS : OURS;
      const owner = inst === OURS ? 'SidCorp-co' : 'someone-else';
      return Response.json({
        total_count: 1,
        repositories: [{ name: 'forge', full_name: `${owner}/forge`, owner: { login: owner } }],
      });
    }
    if (path.startsWith('/apps/')) {
      const status = opts.appPage ?? 200;
      return Response.json({ slug: path.slice('/apps/'.length) }, { status });
    }
    if (path === '/app') {
      return Response.json({
        id: Number(APP_ID),
        slug: 'forge-dev-env',
        client_id: CLIENT_ID,
        owner: { login: 'SidCorp-co', type: 'Organization' },
      });
    }
    if (path.startsWith('/applications/')) {
      return opts.clientSecretHolds === false
        ? Response.json({ message: 'Bad credentials' }, { status: 401 })
        : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (path.startsWith('/app-manifests/')) {
      return Response.json({
        id: Number(APP_ID),
        slug: 'forge-test-app',
        pem: PRIVATE_KEY,
        webhook_secret: WEBHOOK_SECRET,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        html_url: 'https://github.com/apps/forge-test-app',
        owner: { login: 'an-operator', type: 'User' },
      });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  });
  return asked;
}

export async function instanceApp(complete = true): Promise<string> {
  const row = await createConnection({
    ownerType: 'instance',
    ownerId: INSTANCE_OWNER_ID,
    provider: 'github',
    displayName: 'GitHub App forge-test-app',
    config: { appSlug: 'forge-test-app', appOwner: 'an-operator', appOwnerIsOrg: false },
    secrets: {
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      webhookSecret: WEBHOOK_SECRET,
      ...(complete ? { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } : {}),
    },
  });
  return row.id;
}

/** An App an org made before the instance had one: what forge-dev holds until an operator completes it. */
export async function orgOwnedApp(orgId: string): Promise<string> {
  const row = await createConnection({
    ownerType: 'org',
    ownerId: orgId,
    provider: 'github',
    displayName: 'GitHub App forge-dev-env',
    config: {},
    secrets: { appId: APP_ID, privateKey: PRIVATE_KEY, webhookSecret: WEBHOOK_SECRET },
  });
  return row.id;
}

export async function record(connectionId: string, installationId: number, orgId: string) {
  await rows(sql`
    INSERT INTO github_app_installations (connection_id, installation_id, account_login, account_type, org_id, proof)
    VALUES (${connectionId}, ${installationId}, 'SidCorp-co', 'Organization', ${orgId}, 'oauth')
    RETURNING id`);
}

export const installations = () =>
  rows<{ installation_id: string; org_id: string; proof: string; state: string }>(
    sql`SELECT installation_id, org_id, proof, state FROM github_app_installations ORDER BY installation_id`,
  );

export const landing = (res: { status: number; headers: Headers }) => {
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location') as string);
};

export const installed = (token: string, query: string) =>
  api(token, 'GET', `/api/integrations/github/installed?${query}`);

export const target = (installationId: number, owner = 'SidCorp-co') => ({
  provider: 'github',
  installationId,
  owner,
  repo: 'forge',
});

export const bind = (
  token: string,
  connectionId: string,
  projectId: string,
  installationId: number,
) =>
  api(token, 'POST', `/api/integration-connections/${connectionId}/bindings`, {
    bindings: [{ projectId, role: 'service', target: target(installationId) }],
  });

export async function deliver(
  path: string,
  event: string,
  payload: unknown,
  secret = WEBHOOK_SECRET,
) {
  const raw = JSON.stringify(payload);
  const res = await app.fetch(
    new Request(`http://forge.test${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': `guid-${Math.random()}`,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      },
      body: raw,
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export const deliveriesOf = (bindingId: string) =>
  rows<{ status: string; event_name: string }>(
    sql`SELECT status, event_name FROM integration_deliveries WHERE binding_id = ${bindingId}`,
  );
export const allDeliveries = () => rows<{ id: string }>(sql`SELECT id FROM integration_deliveries`);

export async function bindingIdOf(projectId: string): Promise<string> {
  const [row] = await rows<{ id: string }>(
    sql`SELECT id FROM integration_bindings WHERE project_id = ${projectId}`,
  );
  return row?.id as string;
}
