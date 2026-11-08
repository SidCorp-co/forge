// ISS-1070 r10: on forge-dev a project's Needs you sent 21 to 60 statements for its requirements, one
// for a project holding none, and 9 to 50 for its releases, growing with the project's requirements
// and release batches, even read for one project. The scale seed held every requirement agreed at one
// revision and every release shipped, so a read once per requirement, per state or per batch looked
// flat. This seeds the same project shape at a few and at ten times as many requirements over every
// state, and release batches over every state, and holds each area's statements (its `Server-Timing`
// part) to what the few send.
// @direct-test-of packages/core/src/requirements/read.ts
// @direct-test-of packages/core/src/release-batch/release-list-read.ts

import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import { createTestUser } from '../helpers/factories.js';
import { type Scale, seedAtScale } from '../helpers/scale-world.js';

const BASE: Scale = {
  requirements: 6,
  criteriaPerRequirement: 3,
  issues: 120,
  criteriaPerIssue: 2,
  verdictsPerCriterion: 2,
  releases: 50,
  feedback: 30,
  activityPerIssue: 2,
  open: 20,
  live: true,
  states: true,
  batches: 4,
};

/** The few: six requirements, one of each state, and four release batches in play. */
const FEW: Scale = { ...BASE };
/** Ten times as many, as adminhub-api and catalog-api hold on forge-dev. */
const MANY: Scale = { ...BASE, requirements: 60, batches: 40 };

let token: string;
let app: Awaited<typeof import('../../src/index.js')>['app'];

/** Each named part of one GET needs-you's `Server-Timing`, with the statements it sent. */
async function partsOf(projectId: string): Promise<Map<string, number>> {
  const res = await app.request(`/api/projects/${projectId}/needs-you`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Forge-Lifecycle': '10' },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  await res.text();
  const timing = res.headers.get('Server-Timing') ?? '';
  return new Map(
    [...timing.matchAll(/([\w-]+);dur=[\d.]+;desc="(\d+) quer/g)].map(
      (m) => [m[1] as string, Number(m[2])] as const,
    ),
  );
}

/** The median of three reads of each part, after a warm-up that pays the prepared statements. */
async function measured(projectId: string): Promise<Map<string, number>> {
  await partsOf(projectId);
  const runs = [await partsOf(projectId), await partsOf(projectId), await partsOf(projectId)];
  const names = new Set(runs.flatMap((r) => [...r.keys()]));
  return new Map(
    [...names].map((n) => [n, [...runs.map((r) => r.get(n) ?? 0)].sort((a, b) => a - b)[1] ?? 0]),
  );
}

let few: Map<string, number>;
let many: Map<string, number>;

beforeAll(async () => {
  testEnv();
  ({ app } = await import('../../src/index.js'));
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  token = await signUserToken(ownerId);
  const fewId = await seedAtScale(ownerId, FEW);
  const manyId = await seedAtScale(ownerId, MANY);
  few = await measured(fewId);
  many = await measured(manyId);
  // SLOW_READS_OUT=<file> keeps each part's statements, few against many
  if (process.env.SLOW_READS_OUT)
    appendFileSync(
      process.env.SLOW_READS_OUT,
      `needs-you parts, few / many: ${[...many.keys()].map((k) => `${k} ${few.get(k) ?? 0}/${many.get(k)}`).join(', ')}\n`,
    );
}, 600_000);

afterAll(closeWorld);

describe('a project Needs you over requirements in every state and release batches in play', () => {
  it('sends as many statements for its requirements at sixty as at six', () => {
    expect(
      many.get('ny-requirements'),
      `ny-requirements sent ${many.get('ny-requirements')} statements at ${MANY.requirements} requirements, ${few.get('ny-requirements')} at ${FEW.requirements}: a read once per requirement or per state`,
    ).toBeLessThanOrEqual(few.get('ny-requirements') ?? 0);
  });

  it('sends as many statements for its releases at forty batches in play as at four', () => {
    expect(
      many.get('ny-releases'),
      `ny-releases sent ${many.get('ny-releases')} statements at ${MANY.batches} release batches in play, ${few.get('ny-releases')} at ${FEW.batches}: a read once per release`,
    ).toBeLessThanOrEqual(few.get('ny-releases') ?? 0);
  });
});
