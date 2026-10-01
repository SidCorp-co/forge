import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readsOf, undeclaredSourceReads } from './request-reads.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'request-reads-'));
  made.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

describe('the reads a handler makes, read off its text', () => {
  it('tells a validated part from a raw body, a raw query and a forwarded request', () => {
    const reads = readsOf(
      'async (c) => { c.req.valid("json"); await c.req.text(); c.req.queries("a"); return h(c.req.raw); }',
    );

    expect(reads).toEqual([
      { kind: 'validated', part: 'json', via: "c.req.valid('json')" },
      { kind: 'body', via: 'c.req.text()' },
      { kind: 'body', via: 'c.req.raw' },
      { kind: 'query', via: 'c.req.queries()' },
    ]);
  });

  it('does not take a header, the method or the URL origin for an input read', () => {
    expect(
      readsOf('(c) => [c.req.raw.headers, c.req.raw.method, new URL(c.req.url).origin]'),
    ).toEqual([]);
  });
});

describe('a JSON body or query read outside a validator, anywhere in the source', () => {
  it('is refused by file and line, including in a helper no route text shows', () => {
    const root = tree({
      'a/routes.ts': 'export const x = 1;\nasync function read(c) { return c.req.json<Body>(); }\n',
      'b/q.ts': "const since = c.req.query('since');\n",
      'b/q.test.ts': 'await c.req.json();\n',
      'c/raw.ts': 'await c.req.parseBody();\n',
    });

    const refusals = undeclaredSourceReads(root, root);

    expect(refusals.map((r) => r.split(' outside')[0])).toEqual([
      'a/routes.ts:2: reads the request with `.req.json<Body>(`',
      'b/q.ts:1: reads the request with `.req.query(`',
    ]);
  });
});
