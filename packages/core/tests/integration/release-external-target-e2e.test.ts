/**
 * ISS-851 (epod, 2026-11-01): a project whose production is deployed outside Forge, by version tag
 * through forge-ops, could declare no target a release lands on — no binding Forge drives, no
 * promotion branch — so its release sat at RELEASE_TARGET_UNDECLARED and could be neither cut nor
 * recorded. Its production now names the door that deploys it (`deployment.target`) beside a runtime
 * probe identifying the source: its issues wait at the gate, a cut is refused naming the record door,
 * and the record of that door's deploy closes the roster once the probe reads the recorded commit.
 * A target with no probe, or a probe with no target, is still undeclared. Against real Postgres; the
 * probe's HTTP read is planted, since the subject is the declaration, not the fetch.
 *
 * @direct-test-of packages/core/src/release-batch/gate.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveReleaseGate } from '../../src/release-batch/gate.js';
import { api } from '../helpers/api.js';
import {
  BRANCH,
  F4,
  judgedAll,
  landedIssue,
  record,
  refusalsOf,
  seedLandedWorld,
  statusOf,
  world,
} from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const planted = vi.hoisted(() => ({ serving: '', reads: 0 }));

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

vi.mock('../../src/release-batch/verify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/verify.js')>()),
  verifyServingNow: async ({ expected }: { expected: string }) => {
    planted.reads += 1;
    const live = planted.serving;
    const readings = [`https://epod.example.test/version answered ${live}`];
    return live === expected
      ? { ok: true, health: 'up', identity: live, readings }
      : {
          ok: false,
          reason: `the application is healthy and serving ${live}; this record claims ${expected}`,
          live,
          health: 'up',
          identity: live,
          readings,
        };
  },
}));

const PROBE = {
  type: 'http',
  url: 'https://epod.example.test/version',
  path: 'commit',
  identifies: 'source',
} as const;

async function production(deployment: Record<string, unknown>, probes = true) {
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

beforeEach(async () => {
  await seedLandedWorld();
  planted.serving = '';
  planted.reads = 0;
});

describe('a production deployed outside Forge by a door it names (ISS-851)', () => {
  it('is no declared target without its door, or without a probe reading its source', async () => {
    await production({ mode: 'external' });
    await expect(resolveReleaseGate(world.projectId)).rejects.toMatchObject({
      message: expect.stringContaining('deployment.target'),
    });
    await production({ mode: 'external', target: 'forge-ops' }, false);
    await expect(resolveReleaseGate(world.projectId)).rejects.toThrow();
    const issue = await landedIssue(1, F4);
    const refused = await record([issue], F4);
    expect(refused.status).toBe(422);
    expect(refusalsOf(refused.body).map((r) => r.code)).toContain('RELEASE_TARGET_UNDECLARED');
  });

  it('holds its issues at the gate, and a cut is refused naming the record door', async () => {
    await production({ mode: 'external', target: 'forge-ops' });
    expect(await resolveReleaseGate(world.projectId)).toBe('awaiting_release');
    const issue = await landedIssue(1, F4);
    const refused = await cut([issue]);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refusalsOf(refused.body).map((r) => r.code)).toContain('RELEASE_DEPLOYED_OUTSIDE');
    expect(JSON.stringify(refused.body)).toContain('release-records');
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('records the release once its door deployed it, proved by the probe, and closes the roster', async () => {
    await production({ mode: 'external', target: 'forge-ops' });
    const issue = await landedIssue(1, F4);
    await judgedAll(issue, F4);
    // forge-ops has not deployed it yet: the probe reads another commit, and nothing moves
    planted.serving = 'ab'.repeat(20);
    const early = await record([issue], F4);
    expect(early.status, JSON.stringify(early.body)).toBe(422);
    expect(await statusOf(issue)).toBe('awaiting_release');
    // v1.30.0 lands
    planted.serving = F4;
    const res = await record([issue], F4);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ verification: 'probed', closed: [issue], failed: [] });
    expect(planted.reads).toBe(2);
    expect(await statusOf(issue)).toBe('closed');
  });
});
