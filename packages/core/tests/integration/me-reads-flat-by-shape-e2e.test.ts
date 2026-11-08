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
// @direct-test-of packages/core/src/project-config/deploy-adapters/index.ts
// @direct-test-of packages/core/src/release-batch/gate.ts
// @direct-test-of packages/core/src/suggestions/waiting-read.ts
// @direct-test-of packages/core/src/development/needs-you-fold.ts
// @direct-test-of packages/core/src/feedback/forge-reads.ts
// @direct-test-of packages/core/src/issues/release-evidence.ts
// @direct-test-of packages/core/src/release-batch/blockers.ts
// @direct-test-of packages/core/src/release-batch/claim-conflicts.ts
// @direct-test-of packages/core/src/release-batch/shipped-in.ts
// @direct-test-of packages/core/src/release-batch/queries.ts
// @direct-test-of packages/core/src/release-batch/channel.ts
// @direct-test-of packages/core/src/issues/release-record-required.ts
// @direct-test-of packages/core/src/issues/criteria-standing.ts
// @direct-test-of packages/core/src/issues/standing-on.ts

import { appendFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { currentQueryTiming, type QueryTiming } from '../../src/db/query-timing.js';
import { fingerprintOf, shapeTextOf } from '../../src/db/statement-shapes.js';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestUser, seedOrg } from '../helpers/factories.js';
import { forgeDoorReports, liveCoolify, seedEcosystem, wireLive } from '../helpers/live-wiring.js';
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
/**
 * The shapes forge-dev sent four to seven times a read after r12 (2026-11-08), on the projects
 * deployed through a binding: each project's read waited on its Coolify and probe in its own time,
 * so the batch its projects share was read once for each project that came back late (ISS-1070 r13).
 */
const SUBSET: Record<string, string> = {
  '7ec2153a': 'issues/mark-trail.ts:markClaimsRead',
  '97b781a2': 'release-batch/served-ancestry.ts:carriagesOf',
  '4afdafad': 'release-batch/landed-build.ts:recordedLandingsRead',
  '7984d841': 'issues/release-evidence.ts:closedAtRead',
  f5460a1f: 'issues/release-evidence.ts:reopenedAtRead',
  '0a5ffc6e': 'issues/criteria (criterion classes)',
  '2c596d45': 'issues/criteria-anchors.ts:currentContracts',
  '560d08b7': 'feedback (feedback list)',
  '2f55baf0': 'feedback/ship-notice.ts:noticesRead',
  fef8b6eb: 'feedback (home feedback)',
  a8b54f77: 'forecast (home forecasts)',
  e7d7b685: 'issues/standing-rows.ts:rowsWhere',
  bf72f0ab: 'development/needs-you-signoff-words.ts:wordsOf',
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
/** Coolify and the probes, stubbed on one local server counting each call: half the projects deploy there. */
const coolify = liveCoolify();

let app: Awaited<typeof import('../../src/index.js')>['app'];
let acrossToken: string;
let oneToken: string;
let home: string;
/** The wired projects, forge's first. */
let wired: string[];

/** What one GET sent, each named part's statements by shape (the unnamed ones under `unnamed`). */
interface Sent {
  areas: Map<string, Map<string, number>>;
  total: number;
  /** Its wall time and `Server-Timing`'s db and app shares, kept under SLOW_READS_OUT. */
  ms: number;
  timing: string;
  /** Each call the read made to the stub Coolify and probes, by path. */
  http: Map<string, number>;
}

async function sentBy(path: string, token: string): Promise<Sent> {
  const client = (db as unknown as { $client: { unsafe: (...a: unknown[]) => unknown } }).$client;
  const unsafe = client.unsafe;
  let timing: QueryTiming | undefined;
  let ms = 0;
  let serverTiming = '';
  const before = new Map(coolify.calls);
  client.unsafe = (...args: unknown[]) => {
    timing ??= currentQueryTiming();
    return unsafe(...args);
  };
  try {
    const started = performance.now();
    const res = await app.request(path, {
      headers: { Authorization: `Bearer ${token}`, 'X-Forge-Lifecycle': '10' },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    await res.text();
    ms = performance.now() - started;
    serverTiming = res.headers.get('Server-Timing') ?? '';
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
  for (const [path, n] of coolify.calls)
    if (n > (before.get(path) ?? 0)) http.set(path, n - (before.get(path) ?? 0));
  return { areas, total: timing.queries, ms, timing: serverTiming, http };
}

/**
 * The median of the reads by wall time (three, or SLOW_READS_RUNS), after a warm-up that pays the
 * prepared statements; each read's times are kept beside it.
 */
async function measured(
  path: string,
  token: string,
): Promise<Sent & { all: number[]; cold: Sent }> {
  const warm = await sentBy(path, token);
  const runs: Sent[] = [];
  for (let n = 0; n < Math.max(1, Number(process.env.SLOW_READS_RUNS ?? 3)); n++)
    runs.push(await sentBy(path, token));
  const median = [...runs].sort((a, b) => a.ms - b.ms)[Math.floor(runs.length / 2)] as Sent;
  // the calls of the read that asked most, the warm-up's included: a cold read asks too
  const http = new Map<string, number>();
  for (const r of [warm, ...runs])
    for (const [at, n] of r.http) http.set(at, Math.max(n, http.get(at) ?? 0));
  return { ...median, http, cold: warm, all: runs.map((r) => Math.round(r.ms)) };
}

const sum = (m: ReadonlyMap<string, number> | undefined) =>
  [...(m ?? new Map<string, number>()).values()].reduce((n, c) => n + c, 0);

/** Each per-project shape a read sent more than {@link MOST} times, named with its area and code. */
function overMost(path: string, sent: Sent): string[] {
  const out: string[] = [];
  for (const [area, by] of sent.areas)
    for (const [fp, n] of by)
      if ((PER_PROJECT[fp] || SUBSET[fp]) && n > MOST)
        out.push(
          `${path} ${area} sent ${fp} ${n} times (${PER_PROJECT[fp] ?? SUBSET[fp]}), more than ${MOST}`,
        );
  return out;
}

/** Server-Timing's legs: a leg's description may hold a comma of its own. */
const legsIn = (timing: string) => timing.split(/, (?=[a-z-]+[;,]|[a-z-]+$)/);

/** Each shape a read sent more than once, by area, with its statement. */
const repeatsIn = (sent: Sent) =>
  [...sent.areas]
    .flatMap(([a, by]) =>
      [...by]
        .filter(([, n]) => n > 1)
        .map(([fp, n]) => `  ${a} ${fp}*${n} ${(shapeTextOf(fp) ?? '').slice(0, 160)}`),
    )
    .join('\n');

/** What SLOW_READS_OUT keeps of a read: its calls, its times, each area's statements, its repeats. */
function reportOf(path: string, { across, one }: Measured): string {
  const calls = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const head = (t: string) => legsIn(t).slice(0, 3).join(', ');
  const httpLegs = (t: string) =>
    legsIn(t)
      .filter((l) => l.startsWith('http') || /calls?"/.test(l))
      .join(', ');
  const areas = [...across.areas.keys()]
    .map((a) => `${a} ${sum(one.areas.get(a))}/${sum(across.areas.get(a))}`)
    .join(', ');
  return [
    `${path} http twelve ${calls(across.http)} calls (most ${Math.max(0, ...across.http.values())} a path), one ${calls(one.http)}; cold ${httpLegs(across.cold.timing)}`,
    `${path} one ${one.total} / twelve ${across.total}; twelve ${Math.round(across.ms)} ms (${across.all.join(', ')}) ${head(across.timing)}; one ${Math.round(one.ms)} ms (${one.all.join(', ')}) ${head(one.timing)}: ${areas}`,
    repeatsIn(across),
    `${path} cold twelve ${across.cold.total} statements, ${Math.round(across.cold.ms)} ms, ${head(across.cold.timing)}`,
    repeatsIn(across.cold),
    '',
  ].join('\n');
}

type Read = Sent & { all: number[]; cold: Sent };
interface Measured {
  across: Read;
  one: Read;
}
const reads = new Map<string, Measured>();

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
    // projects differ as forge-dev's do: some hold requirements in no state but agreed, some fewer issues
    const scale = { ...SMALL, states: n % 3 !== 1, issues: SMALL.issues - 6 * (n % 4) };
    const id = await seedAtScale(ownerId, scale, { orgId });
    await wireLive(id, ownerId, ecosystemId, n % 2 === 0 ? coolify.url() : undefined);
    ids.push(id);
  }
  home = ids[0] as string;
  wired = ids;
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
    for (const [path, read] of reads)
      appendFileSync(process.env.SLOW_READS_OUT, reportOf(path, read));
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

  // ISS-1070 r13: each production binding's Coolify list and probe were asked twice a read, once for
  // a requirement's coverage and once for a release's basis, each a wait of ~850 ms live
  it('asks each production binding and probe once a read at most', () => {
    expect(
      [...reads].flatMap(([path, { across, one }]) =>
        [
          ...[...across.http].map(([at, n]) => [path, at, n] as const),
          ...[...one.http].map(([at, n]) => [`${path} (one project)`, at, n] as const),
        ]
          .filter(([, , n]) => n > 1)
          .map(([read, at, n]) => `${read} asked ${at.split('/').at(-2)} ${n} times`),
      ),
    ).toEqual([]);
  });

  it('sends each area of attention and home for twelve projects in as many statements as for one', () => {
    const grew = [...reads].flatMap(([path, { across, one }]) => {
      // a batch counts to the area that opened it, which can differ between the two reads: a shape
      // one project sends in another area is that statement moved, not one more
      const elsewhere = new Map<string, number>();
      for (const by of one.areas.values())
        for (const [fp, n] of by) elsewhere.set(fp, (elsewhere.get(fp) ?? 0) + n);
      return [...across.areas].flatMap(([area, by]) => {
        const own = one.areas.get(area);
        const alone = sum(own);
        const moved = [...by]
          .filter(([fp]) => !own?.has(fp))
          .reduce((n, [fp, c]) => n + Math.min(c, elsewhere.get(fp) ?? 0), 0);
        const twelve = sum(by) - moved;
        // the shapes it repeats most, as the operator header names them live, and those one project never sends
        const top = [...by]
          .filter(([fp, n]) => n > 1 || !elsewhere.has(fp))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([fp, n]) => `${fp}*${n} ${(shapeTextOf(fp) ?? '').slice(0, 120)}`);
        return twelve > alone + MOST
          ? [
              `${path} ${area} sent ${twelve} statements for ${PROJECTS} projects (${moved} more moved in from other areas), ${alone} for one: ${top.join(' | ')}`,
            ]
          : [];
      });
    });
    expect(grew).toEqual([]);
  });

  it("reads Forge's feedback reported from many projects' issues in one statement of their prefixes", async () => {
    const needsYou = await measured(`/api/projects/${home}/needs-you`, acrossToken);
    expect(overMost('needs-you', needsYou)).toEqual([]);
  });

  it("weighs each project's draft to the same blockers read alone as read beside the other projects", async () => {
    const { collectReleaseBlockers } = await import('../../src/release-batch/blockers.js');
    const { placeDraft } = await import('../../src/release-batch/release-read.js');
    const { readAcross } = await import('../../src/db/read-memo.js');
    // a release already running on each: its blocker names each project's own run
    for (const p of wired.slice(0, 4))
      await db.execute(sql`
        INSERT INTO pipeline_runs (project_id, kind, status, started_at, release_version, metadata)
        VALUES (${p}, 'system', 'running', now() - interval '2 minutes', '9.9.9',
                '{"source":"release-batch"}'::jsonb)`);
    const weigh = async (p: string) => {
      const draft = await placeDraft(p);
      if (!draft) throw new Error(`project ${p} holds no draft to weigh`);
      return {
        roster: draft.part.issueIds,
        report: await collectReleaseBlockers(p, { issueIds: draft.part.issueIds, door: 'batch' }),
      };
    };
    const alone: Awaited<ReturnType<typeof weigh>>[] = [];
    for (const p of wired) alone.push(await weigh(p));
    const beside = await readAcross(wired, (p) => p, weigh, 'draft-weighing');
    expect(alone.every((a) => a.roster.length > 0)).toBe(true);
    expect(
      alone.filter((a) => a.report.blockers.some((b) => b.code === 'BATCH_IN_FLIGHT')),
    ).toHaveLength(4);
    expect(beside).toEqual(alone);
  });
});
