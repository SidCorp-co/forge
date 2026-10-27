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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { emitEvent } from '../../src/outbox/index.js';
import { declareQueue } from '../../src/queue/boss.js';
import { INTEGRATIONS_QUEUE_NAME } from '../../src/queue/names.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { seedDeployBinding, seedProjectDocument } from '../helpers/release-world.js';

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
