// ISS-1070 r12: forge-dev's operator header (`X-Forge-Statement-Shapes`, r11) named the statements a
// person's attention and home reads still sent once a project: a live master's pass, box slots and
// runs out (21d353f5, 77bb8d03, fdae79fb: home 18 times), the production binding (6b23f1f3) and the
// reworked releases' marks (f9e56c77) on every project deployed through one, each ecosystem member's
// graph (bd88cc6d, d76d530a, e88023e9), the suggestions' targets (24200aac, a6a0b0c4, 00fdfd0e), and
// Forge's feedback read each reporting project's prefix once a row (e36db292). The scale seed held
// none of what reaches them, so its reads looked flat. This wires twelve projects as forge-dev's are
// (`tests/helpers/live-wiring.ts`) and holds each of those shapes to two sends a read, naming the
// shape that went over, and each area of a person's twelve to what it sends for one project.
// @direct-test-of packages/core/src/masters/held-reads.ts
// @direct-test-of packages/core/src/masters/read.ts
// @direct-test-of packages/core/src/ecosystem/graph.ts
// @direct-test-of packages/core/src/integrations/binding-read.ts
// @direct-test-of packages/core/src/suggestions/waiting-read.ts
// @direct-test-of packages/core/src/development/needs-you-fold.ts
// @direct-test-of packages/core/src/feedback/forge-reads.ts
// @direct-test-of packages/core/src/issues/release-evidence.ts

import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { currentQueryTiming, type QueryTiming } from '../../src/db/query-timing.js';
import { fingerprintOf, shapeTextOf } from '../../src/db/statement-shapes.js';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestUser, seedOrg } from '../helpers/factories.js';
import { forgeDoorReports, seedEcosystem, wireLive } from '../helpers/live-wiring.js';
import { type Scale, seedAtScale } from '../helpers/scale-world.js';

/** The shapes forge-dev sent once a project (r11's header, 2026-11-08), by the code that sends them. */
const PER_PROJECT: Record<string, string> = {
  '21d353f5': 'masters/held-reads.ts:runsOutOf',
  '77bb8d03': 'masters/held-reads.ts:slotsHeld',
  fdae79fb: 'masters/read.ts:heldOpenPass',
  '6b23f1f3': 'integrations/binding-read.ts:heldBindingWithConnection',
  f9e56c77: 'issues/release-evidence.ts:mergedAtOf',
  bd88cc6d: 'ecosystem/graph.ts:loadGraph (edges)',
  d76d530a: 'ecosystem/graph.ts:loadGraph (memberships)',
  e88023e9: 'ecosystem/graph.ts:loadGraph (ecosystems)',
  '24200aac': 'suggestions/waiting-read.ts:targetsOf (feedback)',
  a6a0b0c4: 'development/needs-you-fold.ts:triagedItemsOf',
  '00fdfd0e': 'suggestions/waiting-read.ts:targetsOf (requirements)',
  e36db292: 'issues/issue-prefix-read.ts (a project prefix)',
};
/** How often a read may send one of them: a batch split once by the order its projects ask in. */
const MOST = 2;

const SMALL: Scale = {
  requirements: 6,
  criteriaPerRequirement: 3,
  issues: 40,
  criteriaPerIssue: 2,
  verdictsPerCriterion: 2,
  releases: 10,
  feedback: 12,
  activityPerIssue: 2,
  open: 12,
  live: true,
  states: true,
};
const PROJECTS = 12;

let app: Awaited<typeof import('../../src/index.js')>['app'];
let acrossToken: string;
let oneToken: string;
let home: string;

/** What one GET sent, each named part's statements by shape (the unnamed ones under `unnamed`). */
interface Sent {
  areas: Map<string, Map<string, number>>;
  total: number;
}

async function sentBy(path: string, token: string): Promise<Sent> {
  const client = (db as unknown as { $client: { unsafe: (...a: unknown[]) => unknown } }).$client;
  const unsafe = client.unsafe;
  let timing: QueryTiming | undefined;
  client.unsafe = (...args: unknown[]) => {
    timing ??= currentQueryTiming();
    return unsafe(...args);
  };
  try {
    const res = await app.request(path, {
      headers: { Authorization: `Bearer ${token}`, 'X-Forge-Lifecycle': '10' },
    });
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
  return { areas, total: timing.queries };
}

/** The median of three reads by statement count, after a warm-up that pays the prepared statements. */
async function measured(path: string, token: string): Promise<Sent> {
  await sentBy(path, token);
  const runs = [await sentBy(path, token), await sentBy(path, token), await sentBy(path, token)];
  return [...runs].sort((a, b) => a.total - b.total)[1] as Sent;
}

const sum = (m: ReadonlyMap<string, number> | undefined) =>
  [...(m ?? new Map<string, number>()).values()].reduce((n, c) => n + c, 0);

/** Each per-project shape a read sent more than {@link MOST} times, named with its area and code. */
function overMost(path: string, sent: Sent): string[] {
  const out: string[] = [];
  for (const [area, by] of sent.areas)
    for (const [fp, n] of by)
      if (PER_PROJECT[fp] && n > MOST)
        out.push(`${path} ${area} sent ${fp} ${n} times (${PER_PROJECT[fp]}), more than ${MOST}`);
  return out;
}

const reads = new Map<string, { across: Sent; one: Sent }>();

beforeAll(async () => {
  testEnv();
  ({ app } = await import('../../src/index.js'));
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  acrossToken = await signUserToken(ownerId);
  const orgId = await seedOrg(ownerId);
  const ecosystemId = await seedEcosystem(ownerId, orgId);
  const ids: string[] = [];
  for (let n = 0; n < PROJECTS; n++) {
    const id = await seedAtScale(ownerId, SMALL, { orgId });
    await wireLive(id, ownerId, ecosystemId);
    ids.push(id);
  }
  home = ids[0] as string;
  await forgeDoorReports(home, ids.slice(1), ownerId);
  // a person in the one project: what a read of one project sends, each area's floor
  const oneId = (await createTestUser({ verified: true })).id;
  await addProjectMember(home, oneId, 'admin');
  oneToken = await signUserToken(oneId);
  for (const path of ['/api/me/attention', '/api/me/home'])
    reads.set(path, {
      across: await measured(path, acrossToken),
      one: await measured(path, oneToken),
    });
  // SLOW_READS_OUT=<file> keeps each area's statements, one project against twelve
  if (process.env.SLOW_READS_OUT)
    for (const [path, { across, one }] of reads)
      appendFileSync(
        process.env.SLOW_READS_OUT,
        `${path} one ${one.total} / twelve ${across.total}: ${[...across.areas.keys()].map((a) => `${a} ${sum(one.areas.get(a))}/${sum(across.areas.get(a))}`).join(', ')}\n${[
          ...across.areas,
        ]
          .flatMap(([a, by]) =>
            [...by]
              .filter(([, n]) => n > 1)
              .map(([fp, n]) => `  ${a} ${fp}*${n} ${(shapeTextOf(fp) ?? '').slice(0, 160)}`),
          )
          .join('\n')}\n`,
      );
}, 900_000);

afterAll(closeWorld);

describe('a person in twelve projects wired as forge-dev holds them', () => {
  it('sends no statement once a project: each shape forge-dev named at most twice a read', () => {
    expect(
      [...reads].flatMap(([path, { across, one }]) => [
        ...overMost(path, across),
        ...overMost(`${path} (one project)`, one),
      ]),
    ).toEqual([]);
  });

  it('sends each area of attention and home for twelve projects in as many statements as for one', () => {
    const grew = [...reads].flatMap(([path, { across, one }]) =>
      [...across.areas].flatMap(([area, by]) => {
        const twelve = sum(by);
        const alone = sum(one.areas.get(area));
        // the shapes it repeats most, as the operator header names them live
        const top = [...by]
          .filter(([, n]) => n > 1)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([fp, n]) => `${fp}*${n} ${(shapeTextOf(fp) ?? '').slice(0, 120)}`);
        return twelve > alone + MOST
          ? [
              `${path} ${area} sent ${twelve} statements for ${PROJECTS} projects, ${alone} for one: ${top.join(' | ')}`,
            ]
          : [];
      }),
    );
    expect(grew).toEqual([]);
  });

  it("reads Forge's feedback reported from many projects' issues in one statement of their prefixes", async () => {
    const needsYou = await measured(`/api/projects/${home}/needs-you`, acrossToken);
    expect(overMost('needs-you', needsYou)).toEqual([]);
  });
});
