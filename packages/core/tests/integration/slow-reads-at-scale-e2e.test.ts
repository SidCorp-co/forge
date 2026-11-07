// ISS-1070 r2 and r3: the reads the shell and the Dashboard wait on, timed at forge-dev's size. On forge-dev
// (2026-11-07, 532d8d6cd) `/needs-you/decisions` took 8.4 s over 313 queries, `/needs-you` 7 s over
// 313, and the requirement, feedback and release lists the attention read is built from 5 to 8 s each.
// This seeds one project the shape of forge on dev (88 requirements, 1100 issues with their criteria
// and verdicts, 540 releases, 500 feedback) and records each read's statements, its slowest ones and
// its wall time, and holds every statement to a ceiling of shared buffers its plan touches and each
// read to a ceiling of statements and buffers. Set SLOW_READS_OUT to a file to keep the measures,
// SLOW_READS_EXPLAIN to add the slowest plans, SLOW_READS_STACKS to name the code that sent each
// statement, SLOW_READS_PROFILE to a file for a CPU profile of each read, and SLOW_READS_ONLY to a
// pattern of the paths to read.
// @direct-test-of packages/core/src/db/read-memo.ts
// @direct-test-of packages/core/src/issues/standing-read.ts
// @direct-test-of packages/core/src/issues/standing-facts-memo.ts
// @direct-test-of packages/core/src/requirements/standing-share.ts
// @direct-test-of packages/core/src/release-batch/release-list-read.ts
// @direct-test-of packages/core/src/release-batch/shipped-releases.ts
// @direct-test-of packages/core/src/pipeline/release-runs.ts
// @direct-test-of packages/core/src/whats-new/serving.ts

import { appendFileSync } from 'node:fs';
import { QueryPromise } from 'drizzle-orm';
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

const SCALE: Scale = {
  requirements: 88,
  criteriaPerRequirement: 8,
  issues: 1100,
  criteriaPerIssue: 5,
  verdictsPerCriterion: 4,
  releases: 540,
  feedback: 500,
  activityPerIssue: 20,
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
};
/** The projects the person across projects is a member of, forge's among them. */
const PROJECTS_ACROSS = 12;

let ownerId: string;
let token: string;
let projectId: string;
/** A person in {@link PROJECTS_ACROSS} projects, forge's one of them, as the orchestrator is on forge-dev. */
let acrossToken: string;
let app: Awaited<typeof import('../../src/index.js')>['app'];

interface Statement {
  text: string;
  params: unknown;
  ms: number;
  /** The rows it answered, each one the process parses and maps. */
  rows?: number;
  /** Its plan's planning and execution time, run again alone (`buffersOf`). */
  planMs?: number;
  execMs?: number;
  /** The `src/` frames that sent it, when SLOW_READS_STACKS asks for them. */
  site?: string | undefined;
}

interface Measure {
  path: string;
  status: number;
  ms: number;
  /** What the app's own `Server-Timing` says it spent: the database's share, the app's, the whole. */
  timing: string;
  statements: Statement[];
  body: Doc;
}

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
  try {
    const started = performance.now();
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
      timing: res.headers.get('Server-Timing') ?? '',
      statements,
      body: (text ? JSON.parse(text) : null) as Doc,
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

/** One more GET under the V8 profiler, its self time summed by function, written beside `out`. */
async function profiled(path: string, out: string, as: string): Promise<void> {
  const { Session } = await import('node:inspector/promises');
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.start');
  await measured(path, as);
  const { profile } = (await session.post('Profiler.stop')) as {
    profile: {
      nodes: {
        id: number;
        callFrame: { functionName: string; url: string; lineNumber: number };
        children?: number[];
      }[];
      samples: number[];
      timeDeltas: number[];
    };
  };
  session.disconnect();
  const self = new Map<number, number>();
  profile.samples.forEach((id, i) => {
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  });
  const by = new Map<string, number>();
  for (const n of profile.nodes) {
    const f = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/(packages|node_modules)\//, '$1/')}:${n.callFrame.lineNumber}`;
    by.set(f, (by.get(f) ?? 0) + (self.get(n.id) ?? 0));
  }
  const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 40);
  // each sample charged to the nearest frame of core's own code above it: who asked for the work
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const node = new Map(profile.nodes.map((n) => [n.id, n]));
  const charged = new Map<string, number>();
  for (const [id, us] of self) {
    let at: number | undefined = id;
    let name = '(no core frame)';
    while (at !== undefined) {
      const f = node.get(at)?.callFrame;
      if (f?.url.includes('/packages/core/src/')) {
        name = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/packages\/core\/src\//, '')}:${f.lineNumber}`;
        break;
      }
      at = parent.get(at);
    }
    charged.set(name, (charged.get(name) ?? 0) + us);
  }
  const chargedTop = [...charged].sort((a, b) => b[1] - a[1]).slice(0, 30);
  appendFileSync(
    out,
    `## profile ${path}\n${top.map(([f, us]) => `  ${(us / 1000).toFixed(1).padStart(8)} ms  ${f}`).join('\n')}\n` +
      `## charged to core's own frame ${path}\n${chargedTop.map(([f, us]) => `  ${(us / 1000).toFixed(1).padStart(8)} ms  ${f}`).join('\n')}\n`,
  );
}

function report(label: string, m: Measure): string {
  const slowest = [...m.statements].sort((a, b) => b.ms - a.ms).slice(0, 8);
  const same = new Map<string, number>();
  for (const s of m.statements) same.set(s.text, (same.get(s.text) ?? 0) + 1);
  const repeated = [...same].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  return [
    `## ${label} ${m.path} -> ${m.status}: ${m.ms.toFixed(0)} ms, ${m.statements.length} statements, ${repeated.reduce((n, [, c]) => n + c - 1, 0)} repeats | ${m.timing}`,
    ...slowest.map(
      (s) => `  ${s.ms.toFixed(1).padStart(8)} ms  ${s.text.replace(/\s+/g, ' ').slice(0, 260)}`,
    ),
    ...repeated.slice(0, process.env.SLOW_READS_STACKS ? 20 : 5).map(([t, n]) => {
      const sites = [...new Set(m.statements.filter((x) => x.text === t).map((x) => x.site))];
      const at = process.env.SLOW_READS_STACKS ? `\n      from ${sites.join('\n      from ')}` : '';
      return `  x${n} ${t.replace(/\s+/g, ' ').slice(0, 200)}${at}`;
    }),
    ...(process.env.SLOW_READS_STACKS ? sitesOf(m) : []),
  ].join('\n');
}

/** The statements touching the most shared buffers, by the code that sent them where it is named. */
function heaviestSites(heaviest: { own: number; s: Statement }[]): string[] {
  const by = new Map<string, { n: number; own: number; rows: number; plan: number }>();
  for (const { own, s } of heaviest) {
    const at = s.site?.split(' < ')[0] ?? s.text.replace(/\s+/g, ' ').slice(0, 120);
    const was = by.get(at) ?? { n: 0, own: 0, rows: 0, plan: 0 };
    by.set(at, {
      n: was.n + 1,
      own: was.own + own,
      rows: was.rows + (s.rows ?? 0),
      plan: was.plan + (s.planMs ?? 0),
    });
  }
  const top = (of: (v: { own: number; rows: number; plan: number }) => number) =>
    [...by]
      .sort((a, b) => of(b[1]) - of(a[1]))
      .slice(0, Number(process.env.SLOW_READS_HEAVIEST ?? 8));
  const rows = heaviest.reduce((n, { s }) => n + (s.rows ?? 0), 0);
  const plan = heaviest.reduce((n, { s }) => n + (s.planMs ?? 0), 0);
  const exec = heaviest.reduce((n, { s }) => n + (s.execMs ?? 0), 0);
  return [
    `  alone, the database plans them in ${plan.toFixed(0)} ms and runs them in ${exec.toFixed(0)} ms`,
    ...top((v) => v.own).map(
      ([at, { n, own, rows }]) => `  ${String(own).padStart(8)} buf in ${n} (${rows} rows)  ${at}`,
    ),
    ...top((v) => v.plan).map(
      ([at, { n, plan }]) => `  ${plan.toFixed(1).padStart(8)} ms planning ${n}  ${at}`,
    ),
    `  ${rows} rows in all`,
    ...top((v) => v.rows).map(
      ([at, { n, own, rows }]) => `  ${String(rows).padStart(8)} rows in ${n} (${own} buf)  ${at}`,
    ),
  ];
}

/** Each call site's statements: how many, and their summed time, the most first. */
function sitesOf(m: Measure): string[] {
  const by = new Map<string, { n: number; ms: number }>();
  for (const s of m.statements) {
    const at = by.get(s.site ?? '?') ?? { n: 0, ms: 0 };
    by.set(s.site ?? '?', { n: at.n + 1, ms: at.ms + s.ms });
  }
  return [...by]
    .sort((a, b) => b[1].n - a[1].n || b[1].ms - a[1].ms)
    .map(
      ([site, { n, ms }]) => `  @${String(n).padStart(3)} ${ms.toFixed(0).padStart(6)} ms  ${site}`,
    );
}

/**
 * Each read, with the most statements it may send and the most shared buffers their plans may touch
 * together at this size, at what ISS-1070 r4 left it: a statement asked again, a model built twice
 * or a table read whole puts a read over one of them. At r4's base (86309e274) Needs you and its
 * decisions sent 107 over 72 thousand buffers, the attention read 116, the home read 138 over 42
 * thousand, the newest shipped 82 over 23 thousand, What's new 77 over 17 thousand and its summary 3
 * over 5 thousand. The counts are the statements the request sends (its `Server-Timing`), never the
 * work it leaves running.
 */
const READS = (p: string): { path: string; statements: number; buffers: number }[] => [
  { path: `/api/projects/${p}/needs-you`, statements: 106, buffers: 64000 },
  { path: `/api/projects/${p}/needs-you/decisions`, statements: 106, buffers: 64000 },
  { path: `/api/projects/${p}/releases/shipped?limit=3`, statements: 81, buffers: 15000 },
  { path: `/api/projects/${p}/issues/standing?scope=open`, statements: 26, buffers: 5200 },
  { path: '/api/me/attention', statements: 115, buffers: 64000 },
  { path: '/api/me/home', statements: 127, buffers: 27500 },
  { path: '/api/me/whats-new', statements: 77, buffers: 4500 },
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
const READS_ACROSS = (p: string): { path: string; statements: number; buffers: number }[] => [
  { path: '/api/me/attention', statements: 1117, buffers: 216000 },
  { path: '/api/me/home', statements: 1315, buffers: 126000 },
  { path: '/api/me/whats-new', statements: 77, buffers: 4500 },
  { path: '/api/ecosystems/mine', statements: 6, buffers: 50 },
  { path: `/api/projects/${p}/needs-you`, statements: 106, buffers: 64000 },
  { path: `/api/projects/${p}/needs-you/decisions`, statements: 106, buffers: 64000 },
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
  projectId = await seedAtScale(ownerId, SCALE, {
    projectId: PRODUCT,
    servingCommit: process.env.SOURCE_COMMIT as string,
  });
  // the person across projects: an admin of forge's, and in one org holding the rest
  const acrossId = (await createTestUser({ verified: true })).id;
  acrossToken = await signUserToken(acrossId);
  await addProjectMember(projectId, acrossId, 'admin');
  const orgId = await seedOrg(acrossId);
  for (let n = 1; n < PROJECTS_ACROSS; n++) await seedAtScale(acrossId, SHARE, { orgId });
}, 900_000);

afterAll(closeWorld);

/**
 * Reads each path as `as`, a warm-up then three, holds each statement to its buffer ceiling, and
 * answers each read over its ceilings of statements or buffers; every read is measured before any
 * is judged, so one red names each read over its ceiling.
 */
async function judged(
  label: string,
  reads: { path: string; statements: number; buffers: number }[],
  as: string,
): Promise<string[]> {
  const out = process.env.SLOW_READS_OUT;
  const failures: string[] = [];
  const only = process.env.SLOW_READS_ONLY ? new RegExp(process.env.SLOW_READS_ONLY) : null;
  for (const ceiling of reads.filter((r) => !only || only.test(r.path))) {
    const { path } = ceiling;
    const warm = await measured(path, as); // the first request pays for the prepared statements
    expect(warm.status, `${path}: ${JSON.stringify(warm.body).slice(0, 400)}`).toBe(200);
    const runs = [await measured(path, as), await measured(path, as), await measured(path, as)];
    if (process.env.SLOW_READS_PROFILE) await profiled(path, process.env.SLOW_READS_PROFILE, as);
    const median = [...runs].sort((a, b) => a.ms - b.ms)[1] as Measure;
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
    const line = [
      report(`${label}: median of 3 (${runs.map((r) => r.ms.toFixed(0)).join(', ')})`, median),
      `  ceiling: ${median.statements.length} of ${ceiling.statements} statements, ${buffers} of ${ceiling.buffers} buffers`,
      ...heaviestSites(heaviest),
      ...plans,
    ].join('\n');
    if (out) appendFileSync(out, `${line}\n`);
    failures.push(
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
