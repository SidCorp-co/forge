/**
 * The rule inside check-lazy-module-init: which reads of `env` and `db` run when a file is
 * IMPORTED.
 *
 * Each case here was planted against the checker before the checker was finished, and two of them
 * went green when they had to go red: the module-scope IIFE, because the first version of
 * `isImmediatelyInvoked` climbed one parent and `(() => env.X)()` puts a ParenthesizedExpression
 * there. That is why the IIFE cases are the longest part of this file — the fixture that found a
 * hole is the fixture worth keeping.
 *
 * Fixture text is handed straight to `importTimeReads`, which is why the checker exports it: a
 * `--scan-root` flag would test the same rule and would also be a way for a CI run to narrow its
 * own scope, and a gate that can be pointed at a subset reports clean on a tree that is not.
 */
import { describe, expect, it } from 'vitest';
import { importTimeReads } from './check-lazy-module-init.mjs';

// cm:guard the three strings below are FIXTURE TEXT — source this checker parses, not source this
// file runs — and `${process.argv[1]}` inside them is the entrypoint comparison the gate has to
// recognise. Written any other way the fixture stops being the shape it is testing.
// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, parsed rather than evaluated
const IS_MAIN = 'const isMain = import.meta.url === `file://${process.argv[1]}`;\n';
// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, parsed rather than evaluated
const INLINE_GUARD = 'if (import.meta.url === `file://${process.argv[1]}`) {\n';
const IMPORT_ENV = "import { env } from '../config/env.js';\n";
const IMPORT_DB = "import { db } from '../db/client.js';\n";
const reads = (body, header = IMPORT_ENV) =>
  importTimeReads('packages/core/src/fixture.ts', header + body);

describe('check-lazy-module-init — reads that run at import', () => {
  it('catches a direct module-scope read', () => {
    const found = reads('const limit = env.UPLOADS_MAX_BYTES;\n');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
    expect(found[0].name).toBe('env');
  });

  it('catches a read inside an options object at module scope', () => {
    const found = reads('export const mw = bodyLimit({ maxSize: env.UPLOADS_MAX_BYTES });\n');
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('env');
  });

  it('catches a read inside a parenthesised arrow IIFE', () => {
    const found = reads('const port = (() => env.PORT)();\n');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
  });

  it('catches a read inside a function-expression IIFE', () => {
    const found = reads('const port = (function () {\n  return env.PORT;\n})();\n');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(3);
  });

  it('catches a read of db at module scope', () => {
    const found = reads('const rows = db.select();\n', IMPORT_DB);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('db');
  });

  it('names every offending read when a file holds more than one', () => {
    const found = reads('const a = env.PORT;\nconst b = env.NODE_ENV;\n');
    expect(found.map((r) => r.line)).toEqual([2, 3]);
  });
});

describe('check-lazy-module-init — reads that do not run at import', () => {
  it('passes a read inside a request callback', () => {
    const found = reads('export const origin = (o) => env.CORS_ORIGINS.includes(o);\n');
    expect(found).toEqual([]);
  });

  it('passes a read inside a named function that nothing calls at module scope', () => {
    const found = reads('export function port() {\n  return env.PORT;\n}\n');
    expect(found).toEqual([]);
  });

  it('passes a read inside a method', () => {
    const found = reads('export class C {\n  port() {\n    return env.PORT;\n  }\n}\n');
    expect(found).toEqual([]);
  });

  // cm:guard 24 of core's 26 module-scope mentions of `db` are this shape. A checker that counted
  // them would have been 92% noise on its first run, which is how a gate teaches its reader to skip it.
  it('passes a typeof in a type position', () => {
    const found = reads('export type Tx = Pick<typeof db, "select">;\n', IMPORT_DB);
    expect(found).toEqual([]);
  });

  it('passes a type query nested in a generic', () => {
    const found = reads(
      'export type T = Parameters<Parameters<typeof db.transaction>[0]>[0];\n',
      IMPORT_DB,
    );
    expect(found).toEqual([]);
  });

  it('passes a file that imports neither module', () => {
    expect(importTimeReads('packages/core/src/f.ts', 'const x = 1;\n')).toEqual([]);
  });

  it('passes a read of some other export of the same module', () => {
    const found = importTimeReads(
      'packages/core/src/f.ts',
      "import { Env } from '../config/env.js';\nconst x = Env;\n",
    );
    expect(found).toEqual([]);
  });
});

// cm:guard every case below was a hole the checker had and reported clean on. They came out of the
// whole-set review of this change (ISS-1067, F2-F4) rather than from imagination, which is why each
// one is written as the shortest file that reads the environment at import.
describe('check-lazy-module-init — holes the review found', () => {
  it('catches a read through a namespace import', () => {
    const found = importTimeReads(
      'packages/core/src/f.ts',
      "import * as config from '../config/env.js';\nconst port = config.env.PORT;\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('env');
  });

  it('catches a db read through a namespace import', () => {
    const found = importTimeReads(
      'packages/core/src/f.ts',
      "import * as client from '../db/client.js';\nconst rows = client.db.select();\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('db');
  });

  it('passes a namespace read that is deferred into a function', () => {
    const found = importTimeReads(
      'packages/core/src/f.ts',
      "import * as config from '../config/env.js';\nexport const port = () => config.env.PORT;\n",
    );
    expect(found).toEqual([]);
  });

  it('passes a namespace identifier that names no lazy export', () => {
    const found = importTimeReads(
      'packages/core/src/f.ts',
      "import * as config from '../config/env.js';\nexport type E = typeof config;\nconst x = config.EnvSchema;\n",
    );
    expect(found).toEqual([]);
  });

  it('catches a read in the ELSE branch of an entrypoint guard', () => {
    const found = reads(
      `${IS_MAIN}if (isMain) {\n  void 0;\n} else {\n  const port = env.PORT;\n}\n`,
    );
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(6);
  });

  // cm:guard without this, `import.meta.url === import.meta.url` is a two-token way to silence the
  // gate on any block: always true, always runs at import, and read as an entrypoint guard.
  it('catches a read guarded by an always-true url comparison', () => {
    const found = reads(
      'if (import.meta.url === import.meta.url) {\n  const port = env.PORT;\n}\n',
    );
    expect(found).toHaveLength(1);
  });

  // cm:guard the comma expression is what defeated the FIRST fix for this: it mentions
  // `process.argv` and evaluates to `import.meta.url`, so a regex over the operand's text accepted
  // it while the then branch ran on every import.
  it('catches a read guarded by a comparison that only mentions process.argv', () => {
    const found = reads(
      'if (import.meta.url === (process.argv, import.meta.url)) {\n  const port = env.PORT;\n}\n',
    );
    expect(found).toHaveLength(1);
  });

  it('catches a read guarded by a template that is not the entrypoint shape', () => {
    const found = reads(
      `${INLINE_GUARD.replace('file://', 'other://')}  const port = env.PORT;\n}\n`,
    );
    expect(found).toHaveLength(1);
  });

  it('catches a read guarded by a comparison that names no process.argv', () => {
    const found = reads("if (import.meta.url === 'file:///x') {\n  const port = env.PORT;\n}\n");
    expect(found).toHaveLength(1);
  });

  it('catches a read in a computed method name', () => {
    const found = reads('export class C {\n  [env.PORT]() {\n    return 1;\n  }\n}\n');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(3);
  });

  it('catches a read in a computed name while passing the body it wraps', () => {
    const found = reads('export class C {\n  [env.PORT]() {\n    return env.NODE_ENV;\n  }\n}\n');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(3);
  });
});

describe('check-lazy-module-init — the entrypoint guard', () => {
  it('passes a read inside a block guarded by an isMain binding', () => {
    const found = reads(`${IS_MAIN}if (isMain) {\n  const port = env.PORT;\n}\n`);
    expect(found).toEqual([]);
  });

  it('passes a read inside a block guarded by the comparison written inline', () => {
    const found = reads(`${INLINE_GUARD}  const port = env.PORT;\n}\n`);
    expect(found).toEqual([]);
  });

  // cm:guard this is what keeps the guard from being a whole-file exemption: index.ts holds both
  // the bootstrap block and the cors registration, and only the block is outside the property.
  it('catches a read in the same file OUTSIDE that block', () => {
    const found = reads(`${IS_MAIN}const port = env.PORT;\nif (isMain) {\n  void port;\n}\n`);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(3);
  });

  it('catches a read in a block guarded by some other condition', () => {
    const found = reads('const flag = true;\nif (flag) {\n  const port = env.PORT;\n}\n');
    expect(found).toHaveLength(1);
  });
});
