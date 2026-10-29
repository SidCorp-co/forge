// The `@direct-test-when` lines core's two whole-tree tests carry (ISS-769), read from the tests
// themselves and run through the real index and selection over planted files: a carrier read or a
// secret's helper in a file with no hono import still selects credential-doors.test.ts in the
// developer's run, a file that holds neither leaves it out, and the merge check selects it anyway.
// @direct-test-of packages/core/src/middleware/credential-doors.test.ts
// @direct-test-of packages/core/src/lib/reason-caps.test.ts

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexTests, knownFiles, selectDirect } from './direct-tests.mjs';

const REPO = join(import.meta.dirname, '../..');
const DOORS = 'packages/core/src/middleware/credential-doors.test.ts';
const CAPS = 'packages/core/src/lib/reason-caps.test.ts';

const PLANTS = {
  // a param typed Context from a type-only import of a local module: no hono specifier anywhere
  'packages/core/src/plant/type-only-context.ts': [
    "import type { Context } from '../lib/request-types.js';",
    "export const who = (c: Context) => c.req.header('x-forge-user');",
  ],
  // a fetch answer's headers read, in a file that names no carrier type
  'packages/core/src/plant/fetched-header.ts': [
    'export async function etagOf(u: string) {',
    '  const answer = await fetch(u);',
    "  return answer.headers.get('etag');",
    '}',
  ],
  // a URL handed in from elsewhere, read only through a member a URL has
  'packages/core/src/plant/endpoint-query.ts': [
    "import { endpointOf } from './endpoint.js';",
    "export const cursor = (s: string) => endpointOf(s).searchParams.get('cursor');",
  ],
  // no carrier at all: the walk reaches it through the digest helper it imports
  'packages/core/src/plant/through-a-digest.ts': [
    "import { invitationDigest } from '../lib/invitation.js';",
    'export const lookupKey = (token: string) => invitationDigest(token);',
  ],
  // a reason field capped at a literal, what reason-caps.test.ts reads
  'packages/core/src/plant/reason-field.ts': [
    "import { z } from 'zod';",
    'export const body = z.object({ reason: z.string().max(400) });',
  ],
  // pure logic: nothing either test reads
  'packages/core/src/plant/sum.ts': [
    'export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);',
  ],
};

let root = '';
let tests = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'direct-test-when-'));
  const files = {
    [DOORS]: readFileSync(join(REPO, DOORS), 'utf8'),
    [CAPS]: readFileSync(join(REPO, CAPS), 'utf8'),
    ...Object.fromEntries(Object.entries(PLANTS).map(([p, lines]) => [p, `${lines.join('\n')}\n`])),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  tests = indexTests(root, knownFiles(root));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const textOf = (path) => readFileSync(join(root, path), 'utf8');
const selectedBy = (path, opts) =>
  selectDirect([path], tests, opts)
    .collections.flatMap((c) => c.files.map((f) => f.test))
    .sort();

describe("credential-doors.test.ts's @direct-test-when lines, in the developer's run", () => {
  it.each([
    'packages/core/src/plant/type-only-context.ts',
    'packages/core/src/plant/fetched-header.ts',
    'packages/core/src/plant/endpoint-query.ts',
    'packages/core/src/plant/through-a-digest.ts',
  ])('select it for %s, which imports no hono', (plant) => {
    expect(PLANTS[plant].join('\n')).not.toMatch(/['"](?:hono|@hono\/)/);
    expect(selectedBy(plant, { textOf })).toContain(DOORS);
  });

  it('leave it and reason-caps.test.ts out for a pure-logic file, and say so', () => {
    const plant = 'packages/core/src/plant/sum.ts';
    const out = selectDirect([plant], tests, { textOf });
    expect(out.collections).toEqual([]);
    expect(out.narrowed.map((n) => n.test).sort()).toEqual([CAPS, DOORS]);
  });
});

describe("reason-caps.test.ts's @direct-test-when line", () => {
  it('selects it for a reason field and leaves it out for a carrier read', () => {
    expect(selectedBy('packages/core/src/plant/reason-field.ts', { textOf })).toEqual([CAPS]);
    expect(selectedBy('packages/core/src/plant/fetched-header.ts', { textOf })).toEqual([DOORS]);
  });
});

describe('the merge check, which passes no reader', () => {
  it('selects both whole-tree tests for the pure-logic file', () => {
    expect(selectedBy('packages/core/src/plant/sum.ts')).toEqual([CAPS, DOORS]);
  });
});
