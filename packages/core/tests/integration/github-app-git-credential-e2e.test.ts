/**
 * Git authenticated by a GitHub App installation token, against real Postgres.
 *
 * Two propositions, and the second is the one that decides whether the feature
 * may ship: a bound repository yields a token to the box that runs it, and a
 * project with no integration is affected in no way at all.
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  mintGitCredentialForDevice: typeof import('../../src/git/github-app-credential.js').mintGitCredentialForDevice;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  projectsWithGitHubAppCredential: typeof import('../../src/git/github-app-credential.js').projectsWithGitHubAppCredential;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  createConnection: typeof import('../../src/integrations/store.js').createConnection;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  createBinding: typeof import('../../src/integrations/store.js').createBinding;
};

const INSTALLATION_ID = 159473037;
const OWNER = 'SidCorp-co';
const REPO = 'epodsystem_cli';

// cm:why a real RSA key, because `buildAppJwt` signs RS256 for real — only GitHub's HTTP answer is faked, so a broken JWT would still fail here rather than pass on a stub
const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

let harness: TestDatabase;
let mods: Mods;
let ownerId: string;
let projectId: string;
let deviceId: string;

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

  const credential = await import('../../src/git/github-app-credential.js');
  const store = await import('../../src/integrations/store.js');
  mods = {
    mintGitCredentialForDevice: credential.mintGitCredentialForDevice,
    projectsWithGitHubAppCredential: credential.projectsWithGitHubAppCredential,
    createConnection: store.createConnection,
    createBinding: store.createBinding,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  const project = await createTestProject(harness.db, ownerId);
  projectId = project.id;
  const device = await createTestDevice(harness.db, ownerId);
  deviceId = device.id;
});

async function seedRunner(forProjectId = projectId) {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, status, name)
    VALUES (${id}, ${forProjectId}, 'claude-code', ${deviceId}, 'online', 'test-runner')
  `);
  return id;
}

async function seedBinding(
  config: Record<string, unknown> = { owner: OWNER, repo: REPO, installationId: INSTALLATION_ID },
  environment = 'prod',
  forProjectId = projectId,
) {
  const connection = await mods.createConnection({
    ownerType: 'user',
    ownerId,
    provider: 'github',
    displayName: 'GitHub App test',
    // cm:guard a DISTINCT appId per seeded connection — `installationTokenWithExpiry` caches on `base|appId|installationId`, so a shared id lets one test's mint answer the next one's and the assertion on the outbound URL then measures nothing.
    secrets: {
      appId: randomUUID(),
      privateKey: APP_PRIVATE_KEY,
      webhookSecret: 'whs-app',
    },
  });
  return mods.createBinding({
    connectionId: connection.id,
    projectId: forProjectId,
    provider: 'github',
    environment: environment as 'prod',
    config,
    integrationSecret: 'whs-app',
  });
}

describe('projectsWithGitHubAppCredential', () => {
  it('says nothing about a project that has no integration at all', async () => {
    await seedRunner();
    const able = await mods.projectsWithGitHubAppCredential([projectId]);
    expect(able.has(projectId)).toBe(false);
  });

  it('excludes a binding whose App is not installed', async () => {
    await seedBinding({ owner: OWNER, repo: REPO });
    const able = await mods.projectsWithGitHubAppCredential([projectId]);
    expect(able.has(projectId)).toBe(false);
  });

  it('includes a project whose binding names an installation', async () => {
    await seedBinding();
    const able = await mods.projectsWithGitHubAppCredential([projectId]);
    expect(able.has(projectId)).toBe(true);
  });
});

describe('mintGitCredentialForDevice refuses', () => {
  it('a repository no binding on this device names', async () => {
    await seedRunner();
    await seedBinding();
    await expect(
      mods.mintGitCredentialForDevice({
        deviceId,
        host: 'github.com',
        path: `${OWNER}/some-other-repo.git`,
      }),
    ).rejects.toThrow(/no active GitHub App binding for SidCorp-co\/some-other-repo/);
  });

  it('a repository bound to a project this device does NOT run', async () => {
    await seedBinding();
    await expect(
      mods.mintGitCredentialForDevice({
        deviceId,
        host: 'github.com',
        path: `${OWNER}/${REPO}.git`,
      }),
    ).rejects.toThrow(/on any project this device runs/);
  });

  it('a binding whose App was never installed', async () => {
    await seedRunner();
    await seedBinding({ owner: OWNER, repo: REPO });
    await expect(
      mods.mintGitCredentialForDevice({
        deviceId,
        host: 'github.com',
        path: `${OWNER}/${REPO}.git`,
      }),
    ).rejects.toThrow(/the App is not installed for that binding/);
  });

  it('a path that is not owner/repo', async () => {
    await seedRunner();
    await seedBinding();
    await expect(
      mods.mintGitCredentialForDevice({ deviceId, host: 'github.com', path: 'just-one-segment' }),
    ).rejects.toThrow(/useHttpPath=true/);
  });
});

describe('mintGitCredentialForDevice resolves', () => {
  const EXPIRES = '2026-09-08T17:00:00.000Z';

  function stubGitHub() {
    const real = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ token: 'ghs_minted', expires_at: EXPIRES }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = real) };
  }

  it('hands back an x-access-token credential for a bound repository', async () => {
    await seedRunner();
    await seedBinding();
    const stub = stubGitHub();
    try {
      const grant = await mods.mintGitCredentialForDevice({
        deviceId,
        host: 'github.com',
        path: `${OWNER}/${REPO}.git`,
      });
      expect(grant.username).toBe('x-access-token');
      expect(grant.password).toBe('ghs_minted');
      expect(grant.expiresAt).toBe(EXPIRES);
      expect(grant.repository).toBe(`${OWNER}/${REPO}`);
      expect(grant.projectId).toBe(projectId);
      expect(stub.calls[0]).toContain(`/app/installations/${INSTALLATION_ID}/access_tokens`);
    } finally {
      stub.restore();
    }
  });

  it('folds repository case the way GitHub does', async () => {
    await seedRunner();
    await seedBinding();
    const stub = stubGitHub();
    try {
      const grant = await mods.mintGitCredentialForDevice({
        deviceId,
        host: 'github.com',
        path: `${OWNER.toLowerCase()}/${REPO.toUpperCase()}.git`,
      });
      expect(grant.repository).toBe(`${OWNER}/${REPO}`);
    } finally {
      stub.restore();
    }
  });

  it('prefers the prod binding when a staging one names the same repository', async () => {
    await seedRunner();
    await seedBinding({ owner: OWNER, repo: REPO, installationId: 111 }, 'staging');
    await seedBinding({ owner: OWNER, repo: REPO, installationId: INSTALLATION_ID }, 'prod');
    const stub = stubGitHub();
    try {
      await mods.mintGitCredentialForDevice({
        deviceId,
        host: 'github.com',
        path: `${OWNER}/${REPO}.git`,
      });
      expect(stub.calls[0]).toContain(`/app/installations/${INSTALLATION_ID}/access_tokens`);
    } finally {
      stub.restore();
    }
  });
});
