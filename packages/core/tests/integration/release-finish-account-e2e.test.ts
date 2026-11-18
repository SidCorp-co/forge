/**
 * ISS-1334 (FB-744, 2026-11-18): the release brief told its run to say the tag and what it read "in
 * what you record", and no door took prose: `finish` took `commit` and `sites` and refused `summary`
 * with "Unrecognized key", so the run wrote its account as a comment on each roster issue. `finish`
 * now takes the account as `note`, the release page shows it in one place, and a key finish does not
 * take is refused naming `note` as where the prose goes. Through the app's own doors, against real
 * Postgres, Coolify stubbed (`http://coolify.invalid`).
 *
 * @direct-test-of packages/core/src/release-batch/finish-body.ts
 * @direct-test-of packages/core/src/release-batch/run-account.ts
 * @direct-test-of packages/core/src/release-batch/routes.ts
 * @direct-test-of packages/core/src/release-batch/release-read-views.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import {
  registerAllIntegrations,
  releaseWorld,
  seedDeployBinding,
  seedProjectDocument,
} from '../helpers/release-world.js';

const COMMIT = 'a7c0ffee'.padEnd(40, '0');
const ACCOUNT =
  'Tagged v0.2.0 on de7ccf81 and pushed it; read the repo release script and the deploy workflow; the release-runner preference was honoured.';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'github',
    fullName: 'acme/shop',
    branchHead: async () => COMMIT,
  }),
}));

let projectId = '';
let ownerId = '';
let token = '';
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  registerAllIntegrations();
  await startQueue();
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
  const binding = await seedDeployBinding(projectId, ownerId, {
    baseUrl: 'http://coolify.invalid',
    targets: [{ id: 't-shop', label: 'shop', resourceUuid: 'shop-uuid' }],
  });
  await seedProjectDocument(projectId, ownerId, {
    defaultBranch: 'main',
    promotions: [{ from: 'main', to: 'production', via: 'merge' }],
    environments: {
      live: {
        tier: 'production',
        deploysFrom: 'production',
        deployment: { binding, trigger: 'on-request' },
        url: 'https://shop.example.test',
      },
    },
  });
  await fx.seedReleaseRunner();
});

const send = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function cut(): Promise<{ runId: string; version: string; issueId: string }> {
  const issueId = await fx.insertIssue();
  const { runId, version } = await fx.claim([issueId]);
  return { runId, version: String(version), issueId };
}

const accountOf = async (version: string) => {
  const res = await send('GET', `/releases/${version}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { release: { account?: string | null } }).release.account;
};

describe('a release run’s account goes on its finish and shows on its page (ISS-1334)', () => {
  it('refuses a key finish does not take, naming `note` as where the prose goes', async () => {
    const { runId, version } = await cut();

    const res = await send('POST', `/release-batches/${runId}/finish`, {
      commit: COMMIT,
      summary: ACCOUNT,
    });

    expect(res.status).toBe(400);
    const said = JSON.stringify(res.body);
    expect(said).toContain('summary');
    expect(said).toContain('Any other prose goes in `note`');
    expect(await accountOf(version)).toBeNull();
  });

  it('takes the account as `note`, shows it on the release page, and closes the release', async () => {
    const { runId, version, issueId } = await cut();

    const res = await send('POST', `/release-batches/${runId}/finish`, {
      commit: COMMIT,
      note: ACCOUNT,
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const { finishReleaseBatch } = await import('../../src/release-batch/finish.js');
    await finishReleaseBatch(runId, { type: 'user', id: ownerId, agency: 'agent' });

    expect(await accountOf(version)).toBe(ACCOUNT);
    expect(await fx.stored(issueId)).toMatchObject({ status: 'closed' });
  });

  it('shows the account a release recorded by hand took, in the same place', async () => {
    const issueId = await fx.insertIssue();
    const account = 'Deployed 1.4.0 through the integration and watched /api/version report it.';
    const res = await send('POST', '/release-records', {
      issueIds: [issueId],
      version: '1.4.0',
      account,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await accountOf('1.4.0')).toBe(account);
  });
});
