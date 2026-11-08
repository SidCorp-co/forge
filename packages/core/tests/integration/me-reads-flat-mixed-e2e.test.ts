// ISS-1070 r15: forge-dev's operator header named statements a person's attention and home sent
// four to six times a warm read with fourteen projects of mixed kinds, while the wired guard
// (`me-reads-flat-by-shape-e2e.test.ts`) held every shape to two over twelve projects of one kind.
// The mix (`tests/helpers/live-mix.ts`) reads them as forge-dev holds them: storefronts, projects
// that deploy on land beside ones a person cuts, recorded landings, empty and small projects, and
// feedback pointing at workflows, releases and revisions. Every shape is held to two sends an area
// on a warm read, named with the code that sends it.
// @direct-test-of packages/core/src/db/read-memo.ts
// @direct-test-of packages/core/src/db/read-order.ts
// @direct-test-of packages/core/src/feedback/list-read.ts
// @direct-test-of packages/core/src/forecast/release.ts
// @direct-test-of packages/core/src/release-batch/release-list-read.ts
// @direct-test-of packages/core/src/release-batch/release-facts.ts
// @direct-test-of packages/core/src/release-batch/blockers.ts

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  currentLegName,
  currentQueryTiming,
  type QueryTiming,
  quietPoints,
} from '../../src/db/query-timing.js';
import { fingerprintOf, shapeTextOf } from '../../src/db/statement-shapes.js';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import { createTestUser, seedOrg } from '../helpers/factories.js';
import { seedLiveMix } from '../helpers/live-mix.js';
import {
  forgeDoorReports,
  liveAutoflow,
  liveCoolify,
  seedEcosystem,
} from '../helpers/live-wiring.js';

/** The shapes forge-dev's mix sent over twice a warm read (r14's header, 2026-11-08), by the code that sends them. */
const NAMED: Record<string, string> = {
  '7ec2153a': 'issues/mark-trail.ts:markClaimsRead',
  '4afdafad': 'release-batch/landed-build.ts:recordedLandingsRead',
  '97b781a2': 'release-batch/served-ancestry.ts:carriagesOf',
  '7984d841': 'issues/release-evidence.ts:closedAtRead',
  ca6da3c5: 'issues/criteria/service.ts:listCriteria',
  '0a5ffc6e': 'issues/design-record.ts:criterionRoutesRead',
  '2c596d45': 'feedback/list-read.ts:linkedOf (contract providers)',
  '560d08b7': 'feedback/list-read.ts:linkedOf (routed suggestions)',
  fef8b6eb: 'feedback/list-read.ts:linkedOf (workflows)',
  '2f55baf0': 'feedback/list-read.ts:linkedOf (releases)',
  cb834152: 'lib/people.ts:peopleOf',
  '682bd544': 'runs/run-tables (design health)',
  a8b54f77: 'forecast/release.ts:readReleaseLags',
  '045861be': 'issues/standing-facts-read.ts:feedbackOf',
  '1fce89cc': 'issues/standing-facts-read.ts (blocking edges)',
  e7d7b685: 'issues/standing-rows.ts:rowsWhere',
  '9542b7f7': 'release-batch/release-facts.ts (carried verdicts)',
};

/** How often a warm read may send one shape in one area: a batch read again for a later step. */
const MOST = 2;

const coolify = liveCoolify();
const autoflow = liveAutoflow();

let app: Awaited<typeof import('../../src/index.js')>['app'];
let token: string;
let forge: string;

/** Every call either stub has answered so far, by path. */
const callsNow = () => new Map([...coolify.calls, ...autoflow.calls]);

/** Each area's statements by shape, of one GET, and each call it made to a stub platform, by path. */
async function sentBy(path: string): Promise<{
  areas: Map<string, Map<string, number>>;
  http: Map<string, number>;
  waves: Map<string, Set<number>>;
}> {
  const before = callsNow();
  const waves = new Map<string, Set<number>>();
  const client = (db as unknown as { $client: { unsafe: (...a: unknown[]) => unknown } }).$client;
  const unsafe = client.unsafe;
  let timing: QueryTiming | undefined;
  client.unsafe = (...args: unknown[]) => {
    timing ??= currentQueryTiming();
    const area = currentLegName() ?? 'unnamed';
    waves.set(area, (waves.get(area) ?? new Set<number>()).add(quietPoints()));
    return unsafe(...args);
  };
  try {
    const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status, await res.clone().text()).toBe(200);
    await res.text();
  } finally {
    client.unsafe = unsafe;
  }
  if (!timing) throw new Error(`${path} sent no statement inside its timing`);
  const areas = new Map<string, Map<string, number>>();
  const add = (area: string, sent: ReadonlyMap<string, number>) => {
    const by = areas.get(area) ?? new Map<string, number>();
    for (const [text, n] of sent) {
      const fp = fingerprintOf(text);
      by.set(fp, (by.get(fp) ?? 0) + n);
    }
    areas.set(area, by);
  };
  for (const [name, leg] of timing.legs) add(name, leg.sent);
  add('unnamed', timing.sent);
  const http = new Map<string, number>();
  for (const [at, n] of callsNow())
    if (n > (before.get(at) ?? 0)) http.set(at, n - (before.get(at) ?? 0));
  return { areas, http, waves };
}

/**
 * How many waves each area of a warm read sends its statements in at most: the quiet points
 * (`db/query-timing.ts:whenQuiet`) at which it sends any. Each wave waits on the one before it, so
 * at forge-dev's ~3 ms a statement the depth, not the count, sets the time (ISS-1070 r16). Set at
 * the seed's count; lowered by a cut, never raised (r17: ny-releases 26 to 10, ny-requirements 17
 * to 11, ny-issues 9 to 6).
 */
const WAVES: Record<string, Record<string, number>> = {
  '/api/me/attention': {
    'ny-releases': 10,
    'ny-requirements': 11,
    'ny-issues': 6,
    'ny-design-health': 8,
    'ny-feedback': 7,
    'ny-folded': 4,
    'ny-automation': 4,
    'ny-contracts': 3,
  },
  '/api/me/home': {
    'home-forecasts': 15,
    'home-feedback': 10,
    'home-runs': 5,
    'home-live': 4,
    'home-projects': 3,
    'home-items': 2,
    'home-owned': 2,
  },
};

/** Each area of a warm read that sent its statements in more waves than {@link WAVES} allows it. */
async function overWaves(path: string): Promise<string[]> {
  await sentBy(path);
  const { waves } = await sentBy(path);
  const most = WAVES[path] ?? {};
  return [...waves].flatMap(([area, points]) =>
    points.size > (most[area] ?? 2)
      ? [`${path} ${area} sent in ${points.size} waves, more than ${most[area] ?? 2}`]
      : [],
  );
}

/** A statement that locks a row or opens a transaction: a read a person makes needs neither. */
const LOCKS = /^\s*begin\b|\bfor (no key )?update\b|\bfor share\b/i;

/** Each shape a warm read sent over {@link MOST} times in one area, with the code that sends it. */
async function overMost(path: string): Promise<string[]> {
  // the first read is cold: it pays the platforms and teaches each project's way
  await sentBy(path);
  const out: string[] = [];
  for (const [area, by] of (await sentBy(path)).areas)
    for (const [fp, n] of by)
      if (n > MOST)
        out.push(
          `${path} ${area} sent ${fp} ${n} times (${NAMED[fp] ?? (shapeTextOf(fp) ?? '').slice(0, 100)})`,
        );
  return out;
}

/**
 * What a warm read locked, opened a transaction for, or asked a platform: a person's read is shown
 * what a platform answered a moment ago (`db/observed-reads.ts:observedReading`), so it needs no token
 * (`integrations/autoflow/refresh.ts:ensureFreshAutoflowToken`), no lock and no call (ISS-1070 r16).
 */
async function warmWrites(path: string): Promise<string[]> {
  await sentBy(path);
  const { areas, http } = await sentBy(path);
  return [
    ...[...areas].flatMap(([area, by]) =>
      [...by]
        .filter(([fp]) => LOCKS.test(shapeTextOf(fp) ?? ''))
        .map(([fp, n]) => `${path} ${area} sent ${n}× ${(shapeTextOf(fp) ?? fp).slice(0, 80)}`),
    ),
    ...[...http].map(([at, n]) => `${path} asked ${at} ${n} times`),
  ];
}

beforeAll(async () => {
  testEnv();
  ({ app } = await import('../../src/index.js'));
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  token = await signUserToken(ownerId);
  const orgId = await seedOrg(ownerId);
  const ecosystemId = await seedEcosystem(ownerId, orgId);
  const ids = await seedLiveMix({
    ownerId,
    orgId,
    ecosystemId,
    coolify: coolify.url(),
    autoflow: autoflow.url(),
  });
  forge = ids[0] as string;
  await forgeDoorReports(forge, ids.slice(1), ownerId);
}, 900_000);

afterAll(closeWorld);

describe("a person's reads of fourteen projects of forge-dev's kinds", () => {
  it('sends each shape of attention at most twice an area on a warm read', async () => {
    expect(await overMost('/api/me/attention')).toEqual([]);
  });

  it('sends each shape of home at most twice an area on a warm read', async () => {
    expect(await overMost('/api/me/home')).toEqual([]);
  });

  it("sends each shape of forge's own needs-you at most twice an area on a warm read", async () => {
    expect(await overMost(`/api/projects/${forge}/needs-you`)).toEqual([]);
  });

  it('sends each area of attention and home in no more waves than it did', async () => {
    expect([
      ...(await overWaves('/api/me/attention')),
      ...(await overWaves('/api/me/home')),
    ]).toEqual([]);
  });

  it('takes no lock, opens no transaction and asks no platform on a warm read', async () => {
    const found = [];
    for (const path of ['/api/me/attention', '/api/me/home', `/api/projects/${forge}/needs-you`])
      found.push(...(await warmWrites(path)));
    expect(found).toEqual([]);
  });
});
