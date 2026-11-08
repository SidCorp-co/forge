// ISS-1070 r2 and r3: the reads the shell and the Dashboard wait on, timed at forge-dev's size. On forge-dev
// (2026-11-07, 532d8d6cd) `/needs-you/decisions` took 8.4 s over 313 queries, `/needs-you` 7 s over
// 313, and the requirement, feedback and release lists the attention read is built from 5 to 8 s each.
// This seeds one project the shape of forge on dev (88 requirements, 1100 issues with their criteria
// and verdicts, 540 releases, 500 feedback) and records each read's statements, its slowest ones and
// its wall time, and holds every statement to a ceiling of shared buffers its plan touches and each
// read to a ceiling of statements and buffers. Set SLOW_READS_OUT to a file to keep the measures,
// SLOW_READS_EXPLAIN to add the slowest plans, SLOW_READS_STACKS to name the code that sent each
// statement, SLOW_READS_EVERY to list every statement with its time, rows, buffers and plan, SLOW_READS_PROFILE to a file for a CPU profile of each read, and SLOW_READS_ONLY to a
// pattern of the paths to read. SLOW_READS_SHRINK=<n> seeds every count at an n-th (at least one)
// for a quick look at which statements a read sends, its times and ceilings then meaningless.
// SLOW_READS_CHURN=<n> marks n open issues for both read models before each read, as a lease renewal
// marks them on forge-dev, so a read pays the facts it owes. The seed holds forge's live shape
// (`scale-world.ts:Scale.live`, ISS-1070 r8): verdicts over many commits and runtimes, feedback over
// every route; with one commit and one route a read that fans out per row or per project looked flat.
// @direct-test-of packages/core/src/db/read-memo.ts
// @direct-test-of packages/core/src/issues/standing-read.ts
// @direct-test-of packages/core/src/issues/standing-facts-memo.ts
// @direct-test-of packages/core/src/requirements/standing-share.ts
// @direct-test-of packages/core/src/release-batch/release-list-read.ts
// @direct-test-of packages/core/src/release-batch/shipped-releases.ts
// @direct-test-of packages/core/src/pipeline/release-runs.ts
// @direct-test-of packages/core/src/whats-new/serving.ts

import { appendFileSync } from 'node:fs';
import { QueryPromise, sql } from 'drizzle-orm';
import { PgDatabase, PgSelectBase, PgSelectBuilder } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// What's new reads the release of the instance's own product project whose commit this build is:
// the seeded project is that project, and its newest release this build's
const PRODUCT = vi.hoisted(() => {
  const id = '1070a3b5-0000-4000-8000-000000000003';
  process.env.FORGE_ENVIRONMENT = 'dev';
  process.env.FORGE_PRODUCT_PROJECT_ID = id;
  process.env.SOURCE_COMMIT = 'b'.repeat(40);
  return id;
});

import { db } from '../../src/db/client.js';
import { currentQueryTiming } from '../../src/db/query-timing.js';
import { closeWorld, type Doc, testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestUser, seedOrg } from '../helpers/factories.js';
import { type Scale, seedAtScale } from '../helpers/scale-world.js';
import { profiled } from '../helpers/slow-reads-profile.js';
import {
  heaviestSites,
  type Measure,
  report,
  type Statement,
} from '../helpers/slow-reads-report.js';

/** Every count of `s` at an n-th, at least one, under SLOW_READS_SHRINK; `s` itself otherwise. */
function shrunk(s: Scale): Scale {
  const n = Number(process.env.SLOW_READS_SHRINK ?? 1);
  if (!(n > 1)) return s;
  return Object.fromEntries(
    Object.entries(s).map(([k, v]) => [k, Math.max(1, Math.round(Number(v) / n))]),
  ) as unknown as Scale;
}

const SCALE: Scale = {
  requirements: 88,
  criteriaPerRequirement: 8,
  issues: 1100,
  criteriaPerIssue: 5,
  verdictsPerCriterion: 4,
  releases: 540,
  feedback: 500,
  activityPerIssue: 20,
  live: true,
  states: true,
};

/**
 * The rest of a person's projects beside forge, each a share of forge's size: on forge-dev the
 * orchestrator is a member of every project, and its attention read sent 2,224 statements where a
 * project's own Needs you sent 193, one read of each project in turn (ISS-1070 r4).
 */
const SHARE: Scale = {
  requirements: 22,
  criteriaPerRequirement: 6,
  issues: 280,
  criteriaPerIssue: 4,
  verdictsPerCriterion: 3,
  releases: 135,
  feedback: 125,
  activityPerIssue: 8,
  open: 20,
  live: true,
  states: true,
};
/**
 * The share project `n` holds: projects differ in shape, as forge-dev's do (ISS-1070 r9). One holds no
 * release, no design and uniform feedback; one no feedback and no open issue; one is small, with few
 * of each; the rest {@link SHARE}. Over twelve alike projects each reached every batched read at the
 * same step; over these, a project with nothing for one read asks the next a step before the others,
 * and a read that split there sent its statement once for each step a key was reached at (r9's base:
 * attention 158 and home 162 statements where one project sent 149 and 122; after, 146 and 117).
 */
function shareOf(n: number): Scale {
  switch (n % 4) {
    case 1:
      return { ...SHARE, releases: 0, live: false };
    case 2:
      return { ...SHARE, feedback: 0, open: 0 };
    case 3:
      return { ...SHARE, requirements: 6, issues: 60, releases: 10, feedback: 20, open: 30 };
    default:
      // recorded landings on a branch, as catalog-api and adminhub-api hold them (ISS-1070 r10)
      return { ...SHARE, batches: 40 };
  }
}
/** The projects the person across projects is a member of, forge's among them. */
const PROJECTS_ACROSS = 12;

let ownerId: string;
let token: string;
let projectId: string;
/** A person in {@link PROJECTS_ACROSS} projects, forge's one of them, as the orchestrator is on forge-dev. */
let acrossToken: string;
let app: Awaited<typeof import('../../src/index.js')>['app'];

type Unsafe = (
  ...args: unknown[]
) => PromiseLike<unknown> & { handle: () => unknown; executed?: boolean };

/**
 * Where each statement was asked for, under SLOW_READS_STACKS: a drizzle query is a thenable, so an
 * `await` on it runs its `then` in a job of its own and the stack there names no caller. The stack is
 * taken where the query is built, in the caller's own frame, and handed to the statement it sends.
 */
let asking: string | undefined;
function traceSites(): void {
  const keep = <T extends object>(made: T, stack: string | undefined): T => {
    if (made && typeof made === 'object') (made as { site?: string | undefined }).site = stack;
    return made;
  };
  const from = PgSelectBuilder.prototype.from;
  PgSelectBuilder.prototype.from = function (this: unknown, ...a: unknown[]) {
    return keep(from.apply(this, a as never), new Error().stack);
  } as typeof from;
  const execute = PgDatabase.prototype.execute;
  PgDatabase.prototype.execute = function (this: unknown, ...a: unknown[]) {
    return keep(execute.apply(this, a as never), new Error().stack);
  } as typeof execute;
  // a select takes `then` as a mixin copied off QueryPromise when drizzle loads, so each is set apart
  for (const proto of [QueryPromise.prototype, PgSelectBase.prototype] as { then: unknown }[]) {
    const then = proto.then as (...a: unknown[]) => unknown;
    proto.then = function (this: { site?: string }, ...a: unknown[]) {
      const was = asking;
      asking = this.site;
      try {
        return then.apply(this, a);
      } finally {
        asking = was;
      }
    };
  }
}

/** The first `src/` frames of a stack, `file:function` each, so a statement names the code that sent it. */
function siteOf(stack: string): string {
  return stack
    .split('\n')
    .flatMap((l) => {
      const m = /at (?:async )?(\S+) \(.*\/packages\/core\/src\/(.+?):\d+:\d+\)/.exec(l);
      return m && !m[2]?.startsWith('db/') ? [`${m[2]}:${m[1]}`] : [];
    })
    .slice(0, Number(process.env.SLOW_READS_STACKS) || 3)
    .join(' < ');
}

/** One GET, with every statement it sent and how long each took from send to answer. */
async function measured(path: string, as: string = token): Promise<Measure> {
  const client = (db as unknown as { $client: { unsafe: Unsafe } }).$client;
  const statements: Statement[] = [];
  const unsafe = client.unsafe;
  client.unsafe = (...args: unknown[]) => {
    // a statement the request sends, as its Server-Timing counts it; work it leaves running is not its own
    if (!currentQueryTiming()) return unsafe(...args);
    const site = process.env.SLOW_READS_STACKS ? siteOf(asking ?? '') : undefined;
    const query = unsafe(...args);
    const handle = query.handle;
    query.handle = function (this: typeof query) {
      if (!this.executed) {
        const started = performance.now();
        // kept in the order sent, its time filled in when it answers
        const sent: Statement = { text: String(args[0]), params: args[1], ms: 0, site };
        statements.push(sent);
        const done = (result?: unknown) => {
          sent.ms = performance.now() - started;
          if (Array.isArray(result)) sent.rows = result.length;
        };
        Promise.prototype.then.call(this, done, () => done());
      }
      return handle.call(this);
    };
    return query;
  };
  // SLOW_READS_CHURN=<n>: n issues of each project marked for both models before the read, as a lease renewal marks them live
  const churn = Number(process.env.SLOW_READS_CHURN ?? 0);
  if (churn > 0) {
    await db.execute(
      sql`SELECT forge_mark_issues_stale(ARRAY(SELECT id FROM issues WHERE status <> 'closed' ORDER BY random() LIMIT ${churn}), 'lease')`,
    );
  }
  try {
    const started = performance.now();
    const cpu = process.threadCpuUsage();
    const res = await app.request(path, {
      headers: { Authorization: `Bearer ${as}`, 'X-Forge-Lifecycle': '10' },
    });
    const text = await res.text();
    // what the request sent before it answered: work it left running is not its own
    const counted = /desc="(\d+) quer/.exec(res.headers.get('Server-Timing') ?? '')?.[1];
    if (counted === undefined) throw new Error(`${path} answered no Server-Timing count`);
    statements.splice(Number(counted));
    return {
      path,
      status: res.status,
      ms: performance.now() - started,
      cpuMs: ((u) => (u.user + u.system) / 1000)(process.threadCpuUsage(cpu)),
      timing: res.headers.get('Server-Timing') ?? '',
      statements,
      body: (text ? JSON.parse(text) : null) as Doc,
      bytes: Buffer.byteLength(text),
    };
  } finally {
    client.unsafe = unsafe;
  }
}

/** `EXPLAIN (ANALYZE, BUFFERS)` of a statement a read sent, its plan's top lines and its execution time. */
async function explained(s: Statement): Promise<string> {
  const client = (
    db as unknown as {
      $client: { unsafe: (t: string, p?: unknown) => Promise<{ 'QUERY PLAN': string }[]> };
    }
  ).$client;
  try {
    const plan = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${s.text}`, s.params);
    const lines = plan.map((r) => r['QUERY PLAN']);
    return [
      ...lines.slice(0, Number(process.env.SLOW_READS_PLAN_LINES ?? 6)),
      ...lines.filter((l) => /Execution Time|Planning Time/.test(l)),
    ]
      .map((l) => `      | ${l.slice(0, 200)}`)
      .join('\n');
  } catch (err) {
    return `      | (no plan: ${(err as Error).message})`;
  }
}

/**
 * The most shared buffers one statement of these reads may touch at this size. Time on a laptop or
 * a CI box varies; the pages a plan reads do not. Before ISS-1070 r2 the shipped-release read
 * touched 1.36 million (each issue detoasting every release's metadata); the heaviest statement
 * after it, the requirement verdict read, about 35 thousand.
 */
const BUFFERS_PER_STATEMENT = 200_000;

/** The shared buffers a read-only statement's plan touches, children and subplans included. */
async function buffersOf(s: Statement): Promise<number | null> {
  if (!/^\s*(SELECT|WITH)\b/i.test(s.text) || /\b(INSERT|UPDATE|DELETE)\b/i.test(s.text))
    return null;
  const client = (
    db as unknown as {
      $client: { unsafe: (t: string, p?: unknown) => Promise<{ 'QUERY PLAN': unknown }[]> };
    }
  ).$client;
  const [row] = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${s.text}`, s.params);
  const [top] = (row?.['QUERY PLAN'] ?? []) as {
    Plan: Record<string, number>;
    'Planning Time'?: number;
    'Execution Time'?: number;
  }[];
  // what the database spends on it alone, planning and running, kept beside the statement
  s.planMs = top?.['Planning Time'] ?? 0;
  s.execMs = top?.['Execution Time'] ?? 0;
  return (top?.Plan['Shared Hit Blocks'] ?? 0) + (top?.Plan['Shared Read Blocks'] ?? 0);
}

/**
 * Each read, with the most statements it may send and the most shared buffers their plans may touch
 * together at this size, at what ISS-1070 r4 left it: a statement asked again, a model built twice
 * or a table read whole puts a read over one of them. At r4's base (86309e274) Needs you and its
 * decisions sent 107 over 72 thousand buffers, the attention read 116, the home read 138 over 42
 * thousand, the newest shipped 82 over 23 thousand, What's new 77 over 17 thousand and its summary 3
 * over 5 thousand. The counts are the statements the request sends (its `Server-Timing`), never the
 * work it leaves running. ISS-1070 r5 reads the builder rule from the facts each write keeps
 * (`issues/builder-facts.ts`): Needs you and attention fell from 62 to 24 thousand buffers, while a
 * read over few verdicts pays about two buffers a verdict for the joined fact where the rule it
 * replaced was cheaper (What's new 4.2 to 5.8 thousand, the home 26 to 28 thousand): that is the
 * model's read price, and it stands while the fact is joined rather than kept on the verdict row.
 */
interface Ceiling {
  path: string;
  statements: number;
  buffers: number;
  /** Statements a read across projects may send beyond what forge's alone sends, priced where named. */
  beyondAlone?: number;
  /** The slowest warm median it may take, where one is held: the shell waits on it (ISS-1070 r7). */
  ms?: number;
  /**
   * The most CPU time the process may spend answering it, median of the reads, where one is held:
   * its own parsing, joining and freezing, which a loaded box's wait for the database does not move
   * the way it moves `Server-Timing`'s app share (ISS-1070 r11).
   */
  cpuMs?: number;
}

/**
 * The warm median the attention and home reads may take for a person in twelve projects: each read's
 * median once each issue's criteria are stored (ISS-1070 r7: attention 1708 ms, home 1251 ms), times
 * 1.5. At r7's base (021a52159) they took 2546 and 1453 ms. The criterion asks Home and the Dashboard
 * to show content in under 2 s on forge-dev, which has run about 1.4 times this seed: 700 ms here,
 * the ceiling of the round that meets it.
 */
const ATTENTION_ACROSS_MS = 2560;
const HOME_ACROSS_MS = 1880;

/**
 * The statements the shell's attention and home reads send, the one ceiling at one project and at
 * twelve: a person's reads ask each fact once for every project they hold (ISS-1070 r6). One project
 * sends a few more than twelve: alone, it reads each set as asked rather than wait to batch them.
 * Over forge's live shape (ISS-1070 r8) a read sends statements the uniform seed never asked for, once
 * a read however many projects or rows, measured by each part's `Server-Timing` at one project: the
 * feedback list reads its duplicates' roots and the requirements items were routed to with their
 * delivered status (+3, every read); the home reads those requirements by number and their issues
 * (+3), the forecast's requirement lines (+2) and a release over a runtime (+1); attention and Needs
 * you read requirements accepted and dropped beside agreed ones (+1); and the health of forge's 25
 * approved designs, its inputs and its builds' latest runs, once for every design (Needs you and
 * attention +32, What's new and the newest shipped +3). Over r7's uniform seed the reads still send
 * 113, 111 and 105; what grows with projects or rows is {@link ALONE}'s to refuse.
 */
const ATTENTION_STATEMENTS = 149;
// ISS-1070 r10: the home names each project's live releases without the list's summary (122 to 70)
const HOME_STATEMENTS = 74;
/**
 * ISS-1070 r10's seed puts beside forge projects that record landings and hold requirements in every
 * state; on the code before r10 the attention read sent 163 and the home 141 for twelve, against 149
 * and 122 for forge alone. Forge alone asks none of a landing's coverage reads (its marks, trail,
 * shipped holding and kept carriage, once a read since r10) nor a landed release's deploy locks,
 * namings and jobs; and the forecast's landed rows and run spells, each project's as of its own
 * anchor, still split at a second step. Priced until the batch point holds a key for a read a step
 * behind (`db/read-memo.ts:heldFor`): measured 152 to 155 and 73 to 74.
 */
const ATTENTION_ACROSS_STATEMENTS = 155;
const ATTENTION_BEYOND_ALONE = 6;
const HOME_BEYOND_ALONE = 4;
/** Needs you and its decisions, as {@link ATTENTION_STATEMENTS} counts the live shape's few. */
const NEEDS_YOU_STATEMENTS = 142;

// Over the live shape the plans touch more pages, its verdicts naming many commits and runtimes rather
// than one and its designs' health reading their builds (ISS-1070 r8, measured: Needs you 41k,
// attention 39k, home 32.4k, What's new 7.9k, the newest shipped 16.7k, where r7's seed read under
// 27k, 24k, 30k, 7k and 15k)
const READS = (p: string): Ceiling[] => [
  { path: `/api/projects/${p}/needs-you`, statements: NEEDS_YOU_STATEMENTS, buffers: 43000 },
  {
    path: `/api/projects/${p}/needs-you/decisions`,
    statements: NEEDS_YOU_STATEMENTS,
    buffers: 43000,
  },
  // ISS-1070 r10's seed moved it: 20,283 buffers on the code before r10, 20,075 after
  { path: `/api/projects/${p}/releases/shipped?limit=3`, statements: 84, buffers: 20500 },
  // ISS-1070 r9's mixed-shape seed: the open standing read touches 5,262-5,452 buffers, 5,287 on the
  // code before r9, so the seed and not the read moved it; priced until a stored fact replaces its scans
  { path: `/api/projects/${p}/issues/standing?scope=open`, statements: 26, buffers: 5800 },
  { path: '/api/me/attention', statements: ATTENTION_STATEMENTS, buffers: 41000 },
  // ISS-1070 r11: the code before r11 (97d264900) touched 27,011 and 27,023 buffers on this seed,
  // over the 26,000 r8 set; the seed and not the read moved it, priced until a read model replaces its scans
  { path: '/api/me/home', statements: HOME_STATEMENTS, buffers: 27500 },
  // ISS-1070 r10's seed moved it: 10,481 buffers on the code before r10, 10,673 after
  { path: '/api/me/whats-new', statements: 80, buffers: 11000 },
  { path: '/api/me/whats-new/summary', statements: 3, buffers: 100 },
  { path: '/api/ecosystems/mine', statements: 6, buffers: 50 },
];

/**
 * The reads of a person across {@link PROJECTS_ACROSS} projects, with the most statements each may
 * send and the most shared buffers their plans may touch together, at what ISS-1070 r4 left them.
 * At its base (86309e274) each read each project in turn: the attention read sent 1,184 statements
 * over 304 thousand buffers and the home 1,492 over 240 thousand, What's new read 17 thousand
 * buffers finding the release its build is, and Needs you sent 107. What's new and the ecosystems
 * read send as many statements for twelve projects as for one.
 */
const READS_ACROSS = (p: string): Ceiling[] => [
  // a person in twelve projects sends what a person in one does (ISS-1070 r6)
  // ISS-1070 r10's seed moved attention's buffers: 167,201 on the code before r10, 160,787 after
  {
    path: '/api/me/attention',
    statements: ATTENTION_ACROSS_STATEMENTS,
    // ISS-1070 r11: 165,453 and 165,892 on the code before r11 (97d264900), the seed's spread; priced alike
    buffers: 167000,
    ms: ATTENTION_ACROSS_MS,
    beyondAlone: ATTENTION_BEYOND_ALONE,
  },
  {
    path: '/api/me/home',
    statements: HOME_STATEMENTS,
    buffers: 60000,
    ms: HOME_ACROSS_MS,
    beyondAlone: HOME_BEYOND_ALONE,
  },
  { path: '/api/me/whats-new', statements: 80, buffers: 11000 },
  { path: '/api/ecosystems/mine', statements: 6, buffers: 50 },
  { path: `/api/projects/${p}/needs-you`, statements: NEEDS_YOU_STATEMENTS, buffers: 43000 },
  {
    path: `/api/projects/${p}/needs-you/decisions`,
    statements: NEEDS_YOU_STATEMENTS,
    buffers: 43000,
  },
];

beforeAll(async () => {
  testEnv();
  if (process.env.SLOW_READS_STACKS) {
    Error.stackTraceLimit = 60;
    traceSites();
  }
  ({ app } = await import('../../src/index.js'));
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  token = await signUserToken(ownerId);
  projectId = await seedAtScale(ownerId, shrunk(SCALE), {
    projectId: PRODUCT,
    servingCommit: process.env.SOURCE_COMMIT as string,
  });
  // the person across projects: an admin of forge's, and in one org holding the rest
  const acrossId = (await createTestUser({ verified: true })).id;
  acrossToken = await signUserToken(acrossId);
  await addProjectMember(projectId, acrossId, 'admin');
  const orgId = await seedOrg(acrossId);
  for (let n = 1; n < PROJECTS_ACROSS; n++)
    await seedAtScale(acrossId, shrunk(shareOf(n)), { orgId });
}, 900_000);

afterAll(closeWorld);

/**
 * What each path sent read for one project: a read for a person across projects sends no more, since
 * every fact is asked once for all of them. A statement sent once a project or once a row its seed
 * holds more of puts the read over it (ISS-1070 r8: on forge-dev the attention read sent 840
 * statements where one project's Needs you sent 201).
 */
const ALONE = new Map<string, number>();

/**
 * Reads each path as `as`, a warm-up then three, holds each statement to its buffer ceiling, and
 * answers each read over its ceilings of statements or buffers; every read is measured before any
 * is judged, so one red names each read over its ceiling.
 */
async function judged(label: string, reads: Ceiling[], as: string): Promise<string[]> {
  const out = process.env.SLOW_READS_OUT;
  const failures: string[] = [];
  const only = process.env.SLOW_READS_ONLY ? new RegExp(process.env.SLOW_READS_ONLY) : null;
  for (const ceiling of reads.filter((r) => !only || only.test(r.path))) {
    const { path } = ceiling;
    const warm = await measured(path, as); // the first request pays for the prepared statements
    expect(warm.status, `${path}: ${JSON.stringify(warm.body).slice(0, 400)}`).toBe(200);
    // SLOW_READS_RUNS=<n> reads it n times (odd, three by default) and judges the median
    const runs: Measure[] = [];
    for (let n = 0; n < Math.max(1, Number(process.env.SLOW_READS_RUNS ?? 3)); n++)
      runs.push(await measured(path, as));
    if (process.env.SLOW_READS_PROFILE)
      await profiled(path, process.env.SLOW_READS_PROFILE, () => measured(path, as));
    const median = [...runs].sort((a, b) => a.ms - b.ms)[Math.floor(runs.length / 2)] as Measure;
    const cpu = [...runs].map((r) => r.cpuMs).sort((a, b) => a - b)[
      Math.floor(runs.length / 2)
    ] as number;
    // SLOW_READS_EXPLAIN=1 plans the three slowest; any other value is a pattern naming the statements to plan
    const explain = process.env.SLOW_READS_EXPLAIN;
    const match = explain && explain !== '1' ? new RegExp(explain) : null;
    const plans = explain
      ? await Promise.all(
          (match
            ? median.statements.filter((s) => match.test(s.text)).slice(0, 2)
            : [...median.statements].sort((a, b) => b.ms - a.ms).slice(0, 3)
          ).map(
            async (s) =>
              `    plan of ${s.text.replace(/\s+/g, ' ').slice(0, 120)}\n${await explained(s)}`,
          ),
        )
      : [];
    // each statement's plan stays within the ceiling: no read pays once per row for what one read answers
    let buffers = 0;
    const heaviest: { own: number; s: Statement }[] = [];
    for (const s of median.statements) {
      const own = (await buffersOf(s)) ?? 0;
      buffers += own;
      heaviest.push({ own, s });
      expect(
        own,
        `${path} sent a statement touching ${own} buffers: ${s.text.replace(/\s+/g, ' ').slice(0, 300)}`,
      ).toBeLessThanOrEqual(BUFFERS_PER_STATEMENT);
    }
    // SLOW_READS_EVERY lists each statement in the order sent: its time, rows, buffers, plan and site
    const every = process.env.SLOW_READS_EVERY
      ? heaviest.map(
          ({ own, s }, i) =>
            `  #${String(i + 1).padStart(3)} ${s.ms.toFixed(1).padStart(7)} ms ${String(s.rows ?? '-').padStart(6)} rows ${String(own).padStart(6)} buf plan ${(s.planMs ?? 0).toFixed(1)} exec ${(s.execMs ?? 0).toFixed(1)}  ${s.site || s.text.replace(/\s+/g, ' ').slice(0, 160)}`,
        )
      : [];
    const line = [
      report(
        `${label}: median of ${runs.length} (${runs.map((r) => r.ms.toFixed(0)).join(', ')})`,
        median,
      ),
      `  ceiling: ${median.statements.length} of ${ceiling.statements} statements, ${buffers} of ${ceiling.buffers} buffers`,
      ...heaviestSites(heaviest),
      ...every,
      ...plans,
    ].join('\n');
    if (out) appendFileSync(out, `${line}\n`);
    // a person's own reads across their projects: a project's page reads one project for anyone
    const across = path.startsWith('/api/me/');
    const alone = across ? ALONE.get(path) : undefined;
    if (across && alone === undefined) ALONE.set(path, median.statements.length);
    failures.push(
      ...(alone !== undefined && median.statements.length > alone + (ceiling.beyondAlone ?? 0)
        ? [
            `${label} ${path} sent ${median.statements.length} statements, more than the ${alone} it sends for one project${ceiling.beyondAlone ? ` and the ${ceiling.beyondAlone} priced beyond it` : ''}`,
          ]
        : []),
      ...(median.statements.length > ceiling.statements
        ? [
            `${label} ${path} sent ${median.statements.length} statements, over its ceiling of ${ceiling.statements}`,
          ]
        : []),
      ...(buffers > ceiling.buffers
        ? [
            `${label} ${path}'s statements touched ${buffers} shared buffers, over its ceiling of ${ceiling.buffers}`,
          ]
        : []),
      ...(ceiling.cpuMs !== undefined && cpu > ceiling.cpuMs
        ? [
            `${label} ${path} spent ${cpu.toFixed(0)} ms of the process's CPU (median of ${runs.length}), over its ceiling of ${ceiling.cpuMs} ms`,
          ]
        : []),
      ...(ceiling.ms !== undefined && median.ms > ceiling.ms
        ? [
            `${label} ${path} took ${median.ms.toFixed(0)} ms warm (median of 3), over its ceiling of ${ceiling.ms} ms`,
          ]
        : []),
    );
  }
  return failures;
}

describe('the shell and Dashboard reads at forge-dev size', () => {
  it('answers each read within its ceilings of statements and buffers, and records its statements and time', async () => {
    expect(await judged('one project', READS(projectId), token)).toEqual([]);
  }, 600_000);

  it('answers a person in twelve projects within the ceilings of each read across them', async () => {
    expect(
      await judged(`${PROJECTS_ACROSS} projects`, READS_ACROSS(projectId), acrossToken),
    ).toEqual([]);
  }, 900_000);
});
