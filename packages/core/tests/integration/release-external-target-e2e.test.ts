/**
 * ISS-851 (epod, 2026-11-01): a project whose production is deployed outside Forge, by version tag
 * through forge-ops, could declare no target a release lands on, so its release sat at
 * RELEASE_TARGET_UNDECLARED. Its production names the door that deploys it (`deployment.target`) and
 * nothing more: its issues wait at the gate, a cut is refused naming the record door, and the
 * agent's record of the release under its version closes the roster. Owner ruling 2026-11-01
 * (`release-is-the-agents-record`): Forge reads no commit and asks no probe to accept it; a sha the
 * agent sends is kept as evidence only. Against real Postgres, with every live read planted to fail
 * loudly, so a record that reaches for one goes red here.
 *
 * @direct-test-of packages/core/src/release-batch/gate.ts
 * @direct-test-of packages/core/src/release-batch/recorded.ts
 * @direct-test-of packages/core/src/release-batch/routes.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { resolveReleaseGate } from '../../src/release-batch/gate.js';
import { api } from '../helpers/api.js';
import { seedIssueStatus } from '../helpers/factories.js';
import {
  BRANCH,
  F4,
  landedIssue,
  refusalsOf,
  seedLandedWorld,
  statusOf,
  world,
} from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const reads = vi.hoisted(() => ({ n: 0 }));

// a record that reads production is the defect under test: each reader counts and refuses
vi.mock('../../src/release-batch/verify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/verify.js')>()),
  verifyServingNow: async () => {
    reads.n += 1;
    throw new Error('a release record read production (verifyServingNow)');
  },
}));
vi.mock('../../src/release-batch/deployment-verify.js', () => ({
  verifyByDeploymentRecord: async () => {
    reads.n += 1;
    throw new Error('a release record read the deployment record');
  },
}));

const ACCOUNT = 'forge-ops deployed tag v1.31.1 to epod production; I watched it go live.';

const PROBE = {
  type: 'http',
  url: 'https://epod.example.test/version',
  path: 'commit',
  identifies: 'source',
} as const;

async function production(deployment: Record<string, unknown>, probes = false) {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: BRANCH,
    environments: {
      production: {
        tier: 'production',
        deploysFrom: BRANCH,
        deployment: deployment as never,
        ...(probes ? { verification: { runtime: [PROBE] } } : {}),
      },
    },
    extra: { delivery: { verdictsRequired: false } } as never,
  });
}

const cut = (issueIds: string[]) =>
  api(world.token, 'POST', `/api/projects/${world.projectId}/release-batches`, { issueIds });

const record = (issueIds: string[], body: Record<string, unknown> = {}) =>
  api(world.token, 'POST', `/api/projects/${world.projectId}/release-records`, {
    issueIds,
    account: ACCOUNT,
    ...body,
  });

const codes = (body: unknown) => refusalsOf(body).map((r) => r.code);

async function versionOfRun(runId: string): Promise<string | null> {
  const [row] = (await db.execute(
    sql`SELECT release_version FROM pipeline_runs WHERE id = ${runId}`,
  )) as unknown as Array<{ release_version: string | null }>;
  return row?.release_version ?? null;
}

beforeEach(async () => {
  await seedLandedWorld();
  reads.n = 0;
});

describe('a production deployed outside Forge by a door it names (ISS-851)', () => {
  it('declares its target by the door alone, with no source probe', async () => {
    await production({ mode: 'external' });
    await expect(resolveReleaseGate(world.projectId)).rejects.toMatchObject({
      message: expect.stringContaining('deployment.target'),
    });
    await production({ mode: 'external', target: 'forge-ops' });
    expect(await resolveReleaseGate(world.projectId)).toBe('awaiting_release');
  });

  it('holds its issues at the gate, and a cut is refused naming the record door', async () => {
    await production({ mode: 'external', target: 'forge-ops' });
    const issue = await landedIssue(1, F4);
    const refused = await cut([issue]);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(codes(refused.body)).toContain('RELEASE_DEPLOYED_OUTSIDE');
    expect(JSON.stringify(refused.body)).toContain('release-records');
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('records v1.31.1 on the agent word, with no probe and no sha, and closes the roster', async () => {
    await production({ mode: 'external', target: 'forge-ops' });
    const a = await landedIssue(1, F4);
    const b = await landedIssue(2, F4);
    const res = await record([a, b], { version: 'v1.31.1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      version: '1.31.1',
      commit: null,
      identity: null,
      verification: 'unverified',
      failed: [],
    });
    expect(new Set(res.body.closed as string[])).toEqual(new Set([a, b]));
    expect(reads.n).toBe(0);
    expect(await statusOf(a)).toBe('closed');
    expect(await statusOf(b)).toBe('closed');
    expect(await versionOfRun(String(res.body.runId))).toBe('1.31.1');
    // each close carries the version and the account
    const [note] = (await db.execute(sql`
      SELECT body FROM comments WHERE issue_id = ${a} ORDER BY created_at DESC LIMIT 1
    `)) as unknown as Array<{ body: string }>;
    expect(note?.body).toContain('1.31.1');
    expect(note?.body).toContain(ACCOUNT);
    const read = await api(
      world.token,
      'GET',
      `/api/projects/${world.projectId}/release-records/${res.body.runId}`,
    );
    expect(read.body).toMatchObject({ account: ACCOUNT, verification: 'unverified' });
  });

  it('keeps a sha as evidence and never compares it, even where a source probe is declared', async () => {
    await production({ mode: 'external', target: 'forge-ops' }, true);
    const issue = await landedIssue(1, F4);
    const sha = 'ab'.repeat(20);
    const res = await record([issue], { version: '1.31.1', commit: sha });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ version: '1.31.1', commit: sha, closed: [issue] });
    expect(reads.n).toBe(0);
  });

  it('refuses by name a missing or misshapen version, and moves nothing', async () => {
    await production({ mode: 'external', target: 'forge-ops' });
    const issue = await landedIssue(1, F4);
    const missing = await record([issue]);
    expect(missing.status, JSON.stringify(missing.body)).toBe(422);
    expect(codes(missing.body)).toEqual(['RELEASE_VERSION_MISSING']);
    for (const bad of ['1.31', 'v1.31.1.0', 'latest', 'vv1.31.1']) {
      const shaped = await record([issue], { version: bad });
      expect(shaped.status, bad).toBe(422);
      expect(codes(shaped.body), bad).toEqual(['RELEASE_VERSION_SHAPE']);
    }
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('refuses an issue not at awaiting_release, or of another project, and closes none', async () => {
    await production({ mode: 'external', target: 'forge-ops' });
    const ready = await landedIssue(1, F4);
    const early = await landedIssue(2, F4);
    await seedIssueStatus(early, 'in_progress');
    const res = await record([ready, early], { version: 'v1.31.1' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codes(res.body)).toContain('CLAIM_CONFLICT');
    expect(await statusOf(ready)).toBe('awaiting_release');

    const elsewhere = randomUUID();
    const foreign = await record([ready, elsewhere], { version: 'v1.31.1' });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(409);
    expect(codes(foreign.body)).toContain('CLAIM_CONFLICT');
    expect(await statusOf(ready)).toBe('awaiting_release');
  });

  it('closes only the issues named, and refuses a version already on record', async () => {
    await production({ mode: 'external', target: 'forge-ops' });
    const named = await landedIssue(1, F4);
    const other = await landedIssue(2, F4);
    const first = await record([named], { version: 'v1.31.1' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(await statusOf(other)).toBe('awaiting_release');
    const again = await record([other], { version: '1.31.1' });
    expect(again.status, JSON.stringify(again.body)).toBe(422);
    expect(codes(again.body)).toEqual(['RELEASE_RECORD_VERSION_TAKEN']);
    expect(await statusOf(other)).toBe('awaiting_release');
    const next = await record([other], { version: 'v1.31.2' });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(await statusOf(other)).toBe('closed');
  });

  it('refuses a landing branch on a production record by name', async () => {
    await production({ mode: 'external', target: 'forge-ops' });
    const issue = await landedIssue(1, F4);
    const res = await record([issue], { version: 'v1.31.1', branch: BRANCH });
    expect(res.status).toBe(422);
    expect(codes(res.body)).toEqual(['RELEASE_RECORD_BRANCH_UNUSED']);
  });
});
