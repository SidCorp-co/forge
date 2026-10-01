/**
 * What binding a GitHub repository settles for the project, against real
 * Postgres: the webhook secret the binding must carry, and the clone URL the
 * operator should not have to type twice.
 *
 * The secret assertion is a regression: the retired `POST /integration-
 * connections/:id/bindings` minted a `whsec_` of its own, which GitHub never
 * signs with, so every delivery to a repository bound that way failed
 * verification while the hub rendered the integration as configured. The one
 * write left is the binding-v1 document, and these assertions hold it to the
 * same effects.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  githubInboundSecret: typeof import('../../src/integrations/github/bind-effects.js').githubInboundSecret;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  syncRepoUrlFromGitHubBinding: typeof import('../../src/integrations/github/bind-effects.js').syncRepoUrlFromGitHubBinding;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  repoSlugFromGitUrl: typeof import('../../src/integrations/github/bind-effects.js').repoSlugFromGitUrl;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  createConnection: typeof import('../../src/integrations/store.js').createConnection;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
};

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

const OWNER = 'SidCorp-co';
const REPO = 'epodsystem_cli';
const HTTPS = `https://github.com/${OWNER}/${REPO}.git`;

let harness: TestDatabase;
let mods: Mods;
let app: Hono<AppVars>;
let ownerId: string;
let projectId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();

  const effects = await import('../../src/integrations/github/bind-effects.js');
  const store = await import('../../src/integrations/store.js');
  mods = {
    githubInboundSecret: effects.githubInboundSecret,
    syncRepoUrlFromGitHubBinding: effects.syncRepoUrlFromGitHubBinding,
    repoSlugFromGitUrl: effects.repoSlugFromGitUrl,
    createConnection: store.createConnection,
    signUserToken: (await import('../../src/auth/jwt.js')).signUserToken,
  };

  const { integrationConnectionsRoutes } = await import(
    '../../src/integrations/connection-routes.js'
  );
  const { mountProjectConfig } = await import('../../src/project-config/mount.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<AppVars>();
  app.use('*', requestId());
  app.route('/api/integration-connections', integrationConnectionsRoutes);
  mountProjectConfig(app);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  ownerId = owner.id;
  const project = await createTestProject(harness.db, ownerId);
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
});

async function storedRepoUrl(): Promise<string | null> {
  const rows = (await harness.db.execute(sql`
    SELECT repo_url FROM projects WHERE id = ${projectId}
  `)) as unknown as Array<{ repo_url: string | null }>;
  return rows[0]?.repo_url ?? null;
}

async function setRepoUrl(url: string) {
  await harness.db.execute(sql`
    UPDATE projects SET repo_url = ${url} WHERE id = ${projectId}
  `);
}

describe('githubInboundSecret', () => {
  it("returns the App's own webhook secret, which is what GitHub signs with", async () => {
    const connection = await mods.createConnection({
      ownerType: 'user',
      ownerId,
      provider: 'github',
      secrets: { appId: '1', privateKey: 'pem', webhookSecret: 'whs-from-the-app' },
    });
    expect(mods.githubInboundSecret(connection)).toBe('whs-from-the-app');
  });

  it('returns null when the connection holds none, so the caller can mint', async () => {
    const connection = await mods.createConnection({
      ownerType: 'user',
      ownerId,
      provider: 'github',
      secrets: { appId: '1', privateKey: 'pem' },
    });
    expect(mods.githubInboundSecret(connection)).toBeNull();
  });
});

describe('syncRepoUrlFromGitHubBinding', () => {
  it('fills an empty repo URL from the repository just bound', async () => {
    const out = await mods.syncRepoUrlFromGitHubBinding({
      projectId,
      role: 'service',
      config: { owner: OWNER, repo: REPO },
    });
    expect(out).toEqual({ kind: 'set', repoUrl: HTTPS });
    expect(await storedRepoUrl()).toBe(HTTPS);
  });

  it('leaves an SSH remote for the same repository exactly as it was', async () => {
    const ssh = `git@github.com:${OWNER}/${REPO}.git`;
    await setRepoUrl(ssh);
    const out = await mods.syncRepoUrlFromGitHubBinding({
      projectId,
      role: 'service',
      config: { owner: OWNER, repo: REPO },
    });
    expect(out).toEqual({ kind: 'unchanged' });
    expect(await storedRepoUrl()).toBe(ssh);
  });

  it('reports a conflict rather than repointing a project at a different repository', async () => {
    const other = 'git@gitlab.com:sidcorp-internal/webauto.git';
    await setRepoUrl(other);
    const out = await mods.syncRepoUrlFromGitHubBinding({
      projectId,
      role: 'service',
      config: { owner: OWNER, repo: REPO },
    });
    expect(out).toEqual({ kind: 'conflict', existing: other, bound: HTTPS });
    expect(await storedRepoUrl()).toBe(other);
  });

  it('never lets a deploy binding drive the project-tier URL', async () => {
    const out = await mods.syncRepoUrlFromGitHubBinding({
      projectId,
      role: 'deploy',
      config: { owner: OWNER, repo: 'a-fork' },
    });
    expect(out).toEqual({ kind: 'unchanged' });
    expect(await storedRepoUrl()).toBeNull();
  });

  it('does nothing when the binding names no repository yet', async () => {
    const out = await mods.syncRepoUrlFromGitHubBinding({
      projectId,
      role: 'service',
      config: { installationId: 1 },
    });
    expect(out).toEqual({ kind: 'unchanged' });
    expect(await storedRepoUrl()).toBeNull();
  });
});

async function putBinding(bindingId: string, document: Record<string, unknown>) {
  return app.request(`/api/projects/${projectId}/bindings/${bindingId}`, {
    method: 'PUT',
    body: JSON.stringify({
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/binding-v1.json',
        version: 1,
        id: bindingId,
        ...document,
      },
    }),
    headers: {
      authorization: `Bearer ${await mods.signUserToken(ownerId)}`,
      'content-type': 'application/json',
    },
  });
}

async function storedSecrets(): Promise<string[]> {
  const rows = (await harness.db.execute(sql`
    SELECT integration_secret FROM integration_bindings WHERE project_id = ${projectId}
  `)) as unknown as Array<{ integration_secret: string }>;
  return rows.map((r) => r.integration_secret);
}

describe('PUT /projects/:projectId/bindings/:bindingId', () => {
  it('carries the App webhook secret onto the binding and fills the repo URL', async () => {
    const connection = await mods.createConnection({
      ownerType: 'user',
      ownerId,
      provider: 'github',
      secrets: { appId: '1', privateKey: 'pem', webhookSecret: 'whs-from-the-app' },
    });

    const res = await putBinding('6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', {
      role: 'service',
      connection: connection.id,
      target: { provider: 'github', installationId: 42, owner: OWNER, repo: REPO },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created?: boolean; effects?: { repoUrl?: unknown } };
    expect(body.created).toBe(true);
    expect(body.effects?.repoUrl).toEqual({ kind: 'set', repoUrl: HTTPS });
    expect(await storedSecrets()).toEqual(['whs-from-the-app']);
    expect(await storedRepoUrl()).toBe(HTTPS);
  });

  it('mints no second secret and runs no second bind effect when the document is rewritten', async () => {
    const connection = await mods.createConnection({
      ownerType: 'user',
      ownerId,
      provider: 'github',
      secrets: { appId: '1', privateKey: 'pem', webhookSecret: 'whs-from-the-app' },
    });
    const id = '7a2e3d4c-5b6f-4071-9b8c-0d1e2f3a4b5c';
    const first = await putBinding(id, {
      role: 'service',
      connection: connection.id,
      target: { provider: 'github', installationId: 42, owner: OWNER, repo: REPO },
    });
    const { revision } = (await first.json()) as { revision: number };
    await setRepoUrl('https://github.com/acme/elsewhere.git');

    const res = await app.request(`/api/projects/${projectId}/bindings/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        baseRevision: revision,
        document: {
          $schema: 'https://forge.sidcorp.co/schemas/binding-v1.json',
          version: 1,
          id,
          role: 'service',
          connection: connection.id,
          target: { provider: 'github', installationId: 42, owner: OWNER, repo: 'renamed' },
        },
      }),
      headers: {
        authorization: `Bearer ${await mods.signUserToken(ownerId)}`,
        'content-type': 'application/json',
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created?: boolean; effects?: Record<string, unknown> };
    expect(body.created).toBe(false);
    expect(body.effects).toEqual({});
    expect(await storedSecrets()).toEqual(['whs-from-the-app']);
    expect(await storedRepoUrl()).toBe('https://github.com/acme/elsewhere.git');
  });

  it('still mints a secret for a provider that signs with one of ours', async () => {
    const connection = await mods.createConnection({
      ownerType: 'user',
      ownerId,
      provider: 'sentry',
      config: { orgSlug: 'acme' },
      secrets: { authToken: 'tok' },
    });
    const res = await putBinding('8b3f4e5d-6c7a-4182-8c9d-1e2f3a4b5c6d', {
      role: 'service',
      connection: connection.id,
      target: { provider: 'sentry' },
    });
    expect(res.status).toBe(200);
    const [secret] = await storedSecrets();
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(await storedRepoUrl()).toBeNull();
  });
});

describe('the retired binding door', () => {
  it('refuses by name and points at the binding document, writing no row', async () => {
    const connection = await mods.createConnection({
      ownerType: 'user',
      ownerId,
      provider: 'github',
      secrets: { appId: '1', privateKey: 'pem', webhookSecret: 'whs-from-the-app' },
    });
    const res = await app.request(`/api/integration-connections/${connection.id}/bindings`, {
      method: 'POST',
      body: JSON.stringify({ projectId, role: 'service', config: { owner: OWNER, repo: REPO } }),
      headers: {
        authorization: `Bearer ${await mods.signUserToken(ownerId)}`,
        'content-type': 'application/json',
      },
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('BINDING_WRITE_MOVED');
    expect(body.message).toContain('PUT /api/projects/:projectId/bindings/:bindingId');
    expect(await storedSecrets()).toEqual([]);
  });
});

describe('repoSlugFromGitUrl', () => {
  it('reads both transports and neither of the other hosts', () => {
    expect(mods.repoSlugFromGitUrl(HTTPS)).toBe('sidcorp-co/epodsystem_cli');
    expect(mods.repoSlugFromGitUrl(`git@github.com:${OWNER}/${REPO}`)).toBe(
      'sidcorp-co/epodsystem_cli',
    );
    expect(mods.repoSlugFromGitUrl(`ssh://git@github.com/${OWNER}/${REPO}.git`)).toBe(
      'sidcorp-co/epodsystem_cli',
    );
    expect(mods.repoSlugFromGitUrl('git@gitlab.com:sidcorp-internal/webauto.git')).toBeNull();
  });
});
