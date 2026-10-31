/**
 * An environment declaring `trigger: on-land` deploys when work lands on the branch it deploys from
 * (REQ-71 BC-8). catalog-api, 2026-10-27: env `dev` deploys from `dev` through Coolify binding
 * 2538bebc on-land, and merges 105eb7d6 and 307f35d8 through Forge's merge door deployed nothing;
 * both were deployed by hand. Nothing read the trigger off production. The host's push onto `dev`
 * after each merge is the landing, so it is planted here as the hook delivers it.
 *
 * @direct-test-of packages/core/src/release-batch/landing-deploy.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { emitEvent } from '../../src/outbox/index.js';
import { declareQueue } from '../../src/queue/boss.js';
import { INTEGRATIONS_QUEUE_NAME } from '../../src/queue/names.js';
import { deployLanding } from '../../src/release-batch/landing-deploy.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { declareGate, seedDeployBinding, seedProjectDocument } from '../helpers/release-world.js';

/** The source host as a planted GitHub where a test turns it on; every other case reads the real resolver. */
const gateHost = vi.hoisted(() => ({
  on: false,
  committedAt: null as string | null,
  checks: [] as Array<Record<string, unknown>>,
  failWith: null as string | null,
  readAt: [] as string[],
}));

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>();
  const read = async <T>(answer: () => T): Promise<T> => {
    if (gateHost.failWith) throw new Error(gateHost.failWith);
    return answer();
  };
  const planted = {
    provider: 'github',
    fullName: 'acme/catalog-api',
    branchHead: () => read(() => 'ffffffffffffffffffffffffffffffffffffffff'),
    readCommit: (ref: string) =>
      read(() => ({ sha: ref, message: 'a commit', committedAt: gateHost.committedAt })),
    readChecks: (sha: string) =>
      read(() => {
        gateHost.readAt.push(sha);
        return gateHost.checks.map((c) => ({ ...c, headSha: sha }));
      }),
  };
  return {
    ...real,
    resolveSourceHost: (...args: Parameters<typeof real.resolveSourceHost>) =>
      gateHost.on ? Promise.resolve(planted as never) : real.resolveSourceHost(...args),
  };
});

const LANDING = 'dev';
const MERGED = '307f35d820bb5cb74a0f53954aaed97df036431a';
const w = { projectId: '', ownerId: '', bindingId: '' };

beforeAll(async () => {
  testEnv();
  await startQueue();
  // the deploy queue as the server declares it, with no worker: a queued deploy waits to be read
  await declareQueue(INTEGRATIONS_QUEUE_NAME);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** catalog-api's document: one `dev` environment, deployed from `dev` by `trigger`. */
async function catalogApi(trigger: 'on-land' | 'on-request', tier: 'dev' | 'production' = 'dev') {
  await settleOutbox();
  await truncateAll();
  w.ownerId = (await createTestUser({ verified: true })).id;
  w.projectId = (await createTestProject(w.ownerId)).id;
  await addProjectMember(w.projectId, w.ownerId, 'admin');
  w.bindingId = await seedDeployBinding(w.projectId, w.ownerId, {
    targets: [{ id: 'primary', label: 'primary', resourceUuid: 's48k8o8gs0kww8o8swwos88w' }],
  });
  await seedProjectDocument(w.projectId, w.ownerId, {
    defaultBranch: LANDING,
    environments: {
      [tier === 'dev' ? 'dev' : 'live']: {
        tier,
        deploysFrom: LANDING,
        deployment: { binding: w.bindingId, trigger },
      },
    },
  });
}

/** GitLab's push onto `branch` after a merge, as its hook reports it. */
async function pushed(branch: string, commit = MERGED) {
  await emitEvent(db, 'source.pushed', {
    projectId: w.projectId,
    bindingId: w.bindingId,
    branch,
    commit,
  });
  await settleOutbox();
}

/** The Coolify deploys queued for the binding, by the request each was keyed on. */
async function deploysQueued(): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT data->>'requestId' AS request FROM pgboss_v12.job
     WHERE name = 'forge.integrations' AND data->>'bindingId' = ${w.bindingId}
       AND data->>'jobKind' = 'coolify.dispatch'
  `)) as unknown as Array<{ request: string }>;
  return rows.map((r) => r.request).sort();
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM pgboss_v12.job WHERE name = 'forge.integrations'`);
});

describe('a landing deploys the environment declaring on-land (REQ-71 BC-8)', () => {
  it('queues one Coolify deploy of catalog-api dev for the merge landing on dev', async () => {
    await catalogApi('on-land');

    await pushed(LANDING);

    expect(await deploysQueued()).toEqual([`on-land:${w.bindingId}:${MERGED}`]);
  });

  it('deploys a redelivered landing once', async () => {
    await catalogApi('on-land');

    await pushed(LANDING);
    await pushed(LANDING);

    expect(await deploysQueued()).toEqual([`on-land:${w.bindingId}:${MERGED}`]);
  });

  it('deploys nothing for a push to another branch', async () => {
    await catalogApi('on-land');

    await pushed('feat/req4-site-write-through-iss-26');

    expect(await deploysQueued()).toEqual([]);
  });

  it('deploys nothing where the environment deploys on request', async () => {
    await catalogApi('on-request');

    await pushed(LANDING);

    expect(await deploysQueued()).toEqual([]);
  });

  it('leaves production to the release, whatever its trigger', async () => {
    await catalogApi('on-land', 'production');

    await pushed(LANDING);

    expect(await deploysQueued()).toEqual([]);
  });
});

/**
 * ISS-809 / REQ-71 BC-9 — the declared validation gate is read where a landing puts a commit on a
 * non-production environment too: pending is held and named (the delivery fails and is retried, never
 * skipped), red and unreadable are refused by name, and no gate profile relaxes it.
 */
describe('a landing reads the declared validation gate before it deploys (REQ-71 BC-9)', () => {
  const gate = { type: 'github-check', name: 'gate' } as const;
  const check = (conclusion: string | null, status = 'completed') => ({
    id: '9001',
    name: 'gate',
    app: 'github-actions',
    status,
    conclusion,
    detailsUrl: 'https://github.example/acme/catalog-api/actions/runs/9001',
    startedAt: '2026-10-30T10:21:05Z',
    completedAt: status === 'completed' ? '2026-10-30T10:25:00Z' : null,
  });

  beforeEach(async () => {
    await catalogApi('on-land');
    gateHost.on = true;
    gateHost.checks = [];
    gateHost.failWith = null;
    gateHost.readAt = [];
    gateHost.committedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await declareGate(w.projectId, gate);
  });

  afterAll(() => {
    gateHost.on = false;
  });

  const landing = () => deployLanding({ projectId: w.projectId, branch: LANDING, commit: MERGED });

  it('deploys the landing where the gate check passed at the landed commit', async () => {
    gateHost.checks = [check('success')];

    await pushed(LANDING);

    expect(gateHost.readAt).toEqual([MERGED]);
    expect(await deploysQueued()).toEqual([`on-land:${w.bindingId}:${MERGED}`]);
  });

  it('refuses a red check by name and deploys nothing', async () => {
    gateHost.checks = [check('failure')];

    const out = await landing();

    expect(out).toHaveLength(1);
    expect(out[0]?.dispatched).toBe(false);
    expect(out[0]?.why).toContain('RELEASE_GATE_CHECK_RED');
    expect(await deploysQueued()).toEqual([]);
  });

  it('holds a running check by name, deploying nothing, and deploys once it passes', async () => {
    gateHost.checks = [check(null, 'in_progress')];

    await expect(landing()).rejects.toThrow('RELEASE_GATE_CHECK_PENDING');
    expect(await deploysQueued()).toEqual([]);

    gateHost.checks = [check('success')];
    expect((await landing())[0]?.dispatched).toBe(true);
    expect(await deploysQueued()).toEqual([`on-land:${w.bindingId}:${MERGED}`]);
  });

  it('holds a check that has not reported yet, inside the report window', async () => {
    gateHost.checks = [];

    await expect(landing()).rejects.toThrow('RELEASE_GATE_CHECK_PENDING');
    expect(await deploysQueued()).toEqual([]);
  });

  it('refuses a check that never reported, past the report window', async () => {
    gateHost.committedAt = new Date(Date.now() - 45 * 60_000).toISOString();

    const out = await landing();

    expect(out[0]?.why).toContain('RELEASE_GATE_CHECK_SILENT');
    expect(await deploysQueued()).toEqual([]);
  });

  it('refuses a host that cannot be read, never reading it as a pass', async () => {
    gateHost.failWith = 'GitHub answered 502';

    const out = await landing();

    expect(out[0]?.why).toContain('RELEASE_GATE_CHECK_UNREAD');
    expect(out[0]?.why).toContain('GitHub answered 502');
    expect(await deploysQueued()).toEqual([]);
  });

  it('is not relaxed by the yolo profile', async () => {
    await declareGate(w.projectId, gate, 'yolo');
    gateHost.checks = [check('failure')];

    expect((await landing())[0]?.why).toContain('RELEASE_GATE_CHECK_RED');
    expect(await deploysQueued()).toEqual([]);
  });

  it('reads no host where the project declares no gate', async () => {
    await declareGate(w.projectId, { type: 'none' });
    gateHost.checks = [check('failure')];

    await pushed(LANDING);

    expect(gateHost.readAt).toEqual([]);
    expect(await deploysQueued()).toEqual([`on-land:${w.bindingId}:${MERGED}`]);
  });
});
