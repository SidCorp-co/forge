/**
 * ISS-1001, adminhub-fe 2026-11-05: the uncut draft 0.56.0 showed the promotion request !2070
 * (`promote/prod-2026-10-31`), merged on 2026-10-31 and put in production by 0.55.0 that day, whose
 * record pinned no request. The draft read change requests into `release/production` by branch with no
 * bound to its own range: a merged request is the draft's only while production has shipped nothing
 * since it merged. Against real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/promotion-standing.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestRelease } from '../helpers/factories.js';
import {
  call,
  EXTERNAL,
  HEAD,
  heldOnSource,
  landedIssues,
  MERGE,
  promotionRequest,
  STG,
  seedPromotionWorld,
  world,
} from '../helpers/promotion-world.js';

// the host answers as the sibling promotion file plants it: ancestry "diverged", no checks
vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'gitlab',
    fullName: 'acme/adminhub-api',
    compare: async () => 'diverged',
    readChangeRequestChecks: async () => [],
  }),
}));

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  await seedPromotionWorld(EXTERNAL);
});

describe('ISS-1001: a draft shows no promotion request an earlier release already put in production', () => {
  const draftOf = async () => {
    const list = await call('GET', '/releases');
    const releases = (list.body as { releases: Array<{ version: string; state: string }> })
      .releases;
    const draft = releases.find((r) => r.state === 'draft');
    expect(draft, JSON.stringify(list.body)).toBeDefined();
    const read = await call('GET', `/releases/${draft?.version}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    return read.body.release as { version: string; promotion: { label: string } | null };
  };
  const mergedAt = (number: number, at: Date) =>
    db.execute(sql`
      UPDATE repo_pull_requests SET state = 'merged', merge_commit_sha = ${MERGE}, merged_at = ${at.toISOString()}
       WHERE project_id = ${world.projectId} AND number = ${number}`);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  it('leaves !2070 off the draft once 0.55.0 shipped after it merged', async () => {
    await heldOnSource(HEAD);
    await promotionRequest(2070, HEAD, 'promote/prod-2026-10-31');
    await mergedAt(2070, daysAgo(2));
    await createTestRelease(world.projectId, '0.55.0', [], daysAgo(1));
    await landedIssues();

    expect((await draftOf()).promotion).toBeNull();
  });

  it('still pairs the draft with a request merged after production last shipped', async () => {
    await heldOnSource(HEAD);
    await promotionRequest(2070, HEAD, 'promote/prod-2026-10-31');
    await mergedAt(2070, daysAgo(2));
    await createTestRelease(world.projectId, '0.55.0', [], daysAgo(1));
    await heldOnSource('a2'.repeat(20));
    await promotionRequest(2071, 'a2'.repeat(20), 'promote/prod-2026-11-05');
    await mergedAt(2071, new Date());
    await landedIssues();

    expect((await draftOf()).promotion).toMatchObject({ label: '!2071' });
  });

  it('keeps !2070 when what landed since went to release/stg only, which production does not serve', async () => {
    await heldOnSource(HEAD);
    await promotionRequest(2070, HEAD, 'promote/prod-2026-10-31');
    await mergedAt(2070, daysAgo(2));
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
      VALUES (${randomUUID()}, ${world.projectId}, 'system', 'completed', now(), now(), '0.52.0', ${daysAgo(1).toISOString()},
              ${JSON.stringify({ source: 'release-record', verification: 'landed', branch: STG, issueIds: [] })}::jsonb)`);
    await landedIssues();

    expect((await draftOf()).promotion).toMatchObject({ label: '!2070' });
  });
});
