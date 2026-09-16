/**
 * ISS-1053/ISS-1065 — the ground the history CLI tests stand on: fake deps that write into memory,
 * seeded rows, a run file naming one bench room, and the flags of one history call. Shared by
 * `cli.test.ts` and `cli-exclusion.test.ts`; not a test.
 */

import { CORRECTIVE_PREFIX } from '../../../conversations/fallback-replies.js';
import type { CliDeps } from '../cli.js';
import {
  createFakeDeployment,
  DEAD_ISSUE_ID,
  FAKE_TOKEN,
  type FakeState,
} from '../fake-deployment.js';
import type { BenchResult } from '../result.js';

export type SeedRow = FakeState['chatLogs'][number];

export function deps(fetch: CliDeps['fetch'], files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const made: string[] = [];
  const d: CliDeps = {
    fetch,
    readFile: async (path) => {
      const text = files[path] ?? written[path];
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    writeFile: async (path, text) => {
      written[path] = text;
    },
    mkdir: async (path) => {
      made.push(path);
    },
    writeNew: async (path, text) => {
      if (written[path] !== undefined)
        throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
      written[path] = text;
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => new Date('2026-09-16T12:00:00.000Z'),
    randomId: () => 'deadbeef',
  };
  return { d, out, err, written, made };
}

let n = 0;
export const seed = (over: Partial<SeedRow> = {}): SeedRow => {
  n += 1;
  return {
    id: `seed-${String(n).padStart(3, '0')}`,
    sessionId: `real-${n % 4}`,
    projectSlug: 'qa',
    model: 'gpt-x',
    source: 'web-chat-reply',
    query: 'How many open issues?',
    reply: 'Three.',
    toolCalls: [{ name: 'forge', arguments: '{"argv":["issue"]}', isError: false, durationMs: 1 }],
    iterations: 2,
    durationMs: 3000,
    error: null,
    createdAt: `2026-09-10T00:${String(n).padStart(2, '0')}:00.000Z`,
    ...over,
  };
};

export const BENCH_ROOM = 'room-bench-1';
export const seededRows = (): SeedRow[] => [
  seed(),
  seed({ reply: null }),
  seed({ query: `${CORRECTIVE_PREFIX} rewrite`, reply: 'Rewritten.' }),
  seed({ source: 'rocketchat', toolCalls: [{ name: 'forge', arguments: '{"argv":["-h"]}' }] }),
  seed({ sessionId: BENCH_ROOM, reply: null }),
  seed({ sessionId: BENCH_ROOM, reply: `see /projects/qa/issues/${DEAD_ISSUE_ID}` }),
];

export const runFile = (): string =>
  JSON.stringify({
    at: 'x',
    api: 'https://api.test',
    commit: 'abc',
    version: '0.3.0',
    model: 'fake-model',
    runId: 'r',
    k: 3,
    tasks: [
      {
        id: 't',
        capability: 'method',
        trials: [
          {
            at: 'x',
            retried: 0,
            pass: true,
            error: null,
            seconds: 1,
            turns: [],
            cleanup: {
              rooms: [{ id: BENCH_ROOM, expected: 'deleted', observed: '404', at: 'x' }],
              preferences: { expected: null, observed: null, equal: null, at: null },
              auditRowsAdded: 0,
              memories: null,
            },
          },
        ],
      },
    ],
  } satisfies BenchResult);

export const HISTORY = [
  'history',
  '--api',
  'https://api.test',
  '--project',
  'qa',
  '--from',
  '2026-09-01',
  '--to',
  '2026-09-16',
  '--out',
  '/tmp/h.json',
];
export const ENV = { FORGE_BENCH_TOKEN: FAKE_TOKEN };
export const fake = (rows = seededRows()) =>
  createFakeDeployment({ script: () => ({ attempts: [{ reply: 'x' }] }), rows });
