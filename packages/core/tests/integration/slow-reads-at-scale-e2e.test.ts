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
import { createTestUser } from '../helpers/factories.js';
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

let ownerId: string;
let token: string;
let projectId: string;
let app: Awaited<typeof import('../../src/index.js')>['app'];

interface Statement {
  text: string;
  params: unknown;
  ms: number;
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
async function measured(path: string): Promise<Measure> {
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
        const done = () => {
          sent.ms = performance.now() - started;
        };
        Promise.prototype.then.call(this, done, done);
      }
      return handle.call(this);
    };
    return query;
  };
  try {
    const started = performance.now();
    const res = await app.request(path, {
      headers: { Authorization: `Bearer ${token}`, 'X-Forge-Lifecycle': '10' },
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
  const [top] = (row?.['QUERY PLAN'] ?? []) as { Plan: Record<string, number> }[];
  return (top?.Plan['Shared Hit Blocks'] ?? 0) + (top?.Plan['Shared Read Blocks'] ?? 0);
}

/** One more GET under the V8 profiler, its self time summed by function, written beside `out`. */
async function profiled(path: string, out: string): Promise<void> {
  const { Session } = await import('node:inspector/promises');
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.start');
  await measured(path);
  const { profile } = (await session.post('Profiler.stop')) as {
    profile: {
      nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
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
  appendFileSync(
    out,
    `## profile ${path}\n${top.map(([f, us]) => `  ${(us / 1000).toFixed(1).padStart(8)} ms  ${f}`).join('\n')}\n`,
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
 * together at this size, at what ISS-1070 r3 left it: a statement asked again, a model built twice
 * or a table read whole puts a read over one of them. At r3's base (1c38cc063) Needs you and its
 * decisions sent 167 over 78 thousand buffers, the attention read 176, the home read 157, the newest
 * shipped 81 over 18 thousand and What's new 76. The counts are the statements the request sends
 * (its `Server-Timing`), never the work it leaves running.
 */
const READS = (p: string): { path: string; statements: number; buffers: number }[] => [
  { path: `/api/projects/${p}/needs-you`, statements: 104, buffers: 58000 },
  { path: `/api/projects/${p}/needs-you/decisions`, statements: 104, buffers: 58000 },
  { path: `/api/projects/${p}/releases/shipped?limit=3`, statements: 79, buffers: 17500 },
  { path: `/api/projects/${p}/issues/standing?scope=open`, statements: 25, buffers: 3800 },
  { path: '/api/me/attention', statements: 113, buffers: 58000 },
  { path: '/api/me/home', statements: 135, buffers: 38500 },
  { path: '/api/me/whats-new', statements: 74, buffers: 12000 },
  { path: '/api/me/whats-new/summary', statements: 3, buffers: 5500 },
  { path: '/api/ecosystems/mine', statements: 6, buffers: 50 },
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
}, 300_000);

afterAll(closeWorld);

describe('the shell and Dashboard reads at forge-dev size', () => {
  it('answers each read within its ceilings of statements and buffers, and records its statements and time', async () => {
    const out = process.env.SLOW_READS_OUT;
    const failures: string[] = [];
    const only = process.env.SLOW_READS_ONLY ? new RegExp(process.env.SLOW_READS_ONLY) : null;
    for (const ceiling of READS(projectId).filter((r) => !only || only.test(r.path))) {
      const { path } = ceiling;
      const warm = await measured(path); // the first request pays for the prepared statements
      expect(warm.status, `${path}: ${JSON.stringify(warm.body).slice(0, 400)}`).toBe(200);
      const runs = [await measured(path), await measured(path), await measured(path)];
      if (process.env.SLOW_READS_PROFILE) await profiled(path, process.env.SLOW_READS_PROFILE);
      const median = [...runs].sort((a, b) => a.ms - b.ms)[1] as Measure;
      const plans = process.env.SLOW_READS_EXPLAIN
        ? await Promise.all(
            [...median.statements]
              .sort((a, b) => b.ms - a.ms)
              .slice(0, 3)
              .map(
                async (s) =>
                  `    plan of ${s.text.replace(/\s+/g, ' ').slice(0, 120)}\n${await explained(s)}`,
              ),
          )
        : [];
      // each statement's plan stays within the ceiling: no read pays once per row for what one read answers
      let buffers = 0;
      for (const s of median.statements) {
        const own = (await buffersOf(s)) ?? 0;
        buffers += own;
        expect(
          own,
          `${path} sent a statement touching ${own} buffers: ${s.text.replace(/\s+/g, ' ').slice(0, 300)}`,
        ).toBeLessThanOrEqual(BUFFERS_PER_STATEMENT);
      }
      const line = [
        report(`median of 3 (${runs.map((r) => r.ms.toFixed(0)).join(', ')})`, median),
        `  ceiling: ${median.statements.length} of ${ceiling.statements} statements, ${buffers} of ${ceiling.buffers} buffers`,
        ...plans,
      ].join('\n');
      if (out) appendFileSync(out, `${line}\n`);
      failures.push(
        ...(median.statements.length > ceiling.statements
          ? [
              `${path} sent ${median.statements.length} statements, over its ceiling of ${ceiling.statements}`,
            ]
          : []),
        ...(buffers > ceiling.buffers
          ? [
              `${path}'s statements touched ${buffers} shared buffers, over its ceiling of ${ceiling.buffers}`,
            ]
          : []),
      );
    }
    // every read is measured before any is judged, so one red names each read over its ceiling
    expect(failures).toEqual([]);
  }, 600_000);
});
