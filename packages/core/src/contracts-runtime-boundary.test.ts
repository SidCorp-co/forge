import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard: core must NEVER import a runtime VALUE from `@forge/contracts`.
 *
 * `@forge/contracts` is a type-only surface (its own package.json: "Type-only
 * surface — no runtime coupling") and is NOT present in core's production
 * runtime image. A `tsc` build resolves it via the pnpm workspace symlink, so a
 * value import compiles green — then crashes at boot in prod with
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@forge/contracts'`, taking the
 * whole API down (this is exactly what ISS-510's `notifications/emit.ts` did).
 *
 * `import type { … }` is erased at compile time and is fine. Anything that
 * survives compilation — a default import, a namespace import, a side-effect
 * import, or a named import where any binding is not `type`-prefixed — is a
 * runtime import and is forbidden. Inline the value into core (or source it
 * from `db/schema`) instead.
 *
 * Scans non-test source only: `*.test.ts` never ships to `dist`, so test-time
 * value imports of contracts enums/tuples (parity tests) are harmless.
 */

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...walk(p));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

// `import <clause> from '@forge/contracts…'` — the clause may span lines but
// cannot contain another `from`, so it never bleeds across statements.
const FROM_IMPORT = /import\s+((?:(?!\bfrom\b)[\s\S])*?)\s*from\s*['"]@forge\/contracts[^'"]*['"]/g;
// `import '@forge/contracts…'` — a side-effect import (always runtime).
const SIDE_EFFECT = /import\s+['"]@forge\/contracts[^'"]*['"]/g;

function runtimeImportsOf(src: string): string[] {
  const bad: string[] = [];
  for (const m of src.matchAll(SIDE_EFFECT)) bad.push(m[0].trim());
  for (const m of src.matchAll(FROM_IMPORT)) {
    const clause = (m[1] ?? '').trim();
    if (clause.startsWith('type ')) continue; // `import type { … }` / `import type X`
    const named = clause.match(/^\{([\s\S]*)\}$/);
    if (named) {
      const allTypeOnly = (named[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .every((s) => /^type\s/.test(s));
      if (!allTypeOnly) bad.push(`import ${clause} from '@forge/contracts'`);
    } else {
      // default import (`import Foo from …`) or namespace (`import * as ns …`)
      bad.push(`import ${clause} from '@forge/contracts'`);
    }
  }
  return bad;
}

describe('@forge/contracts runtime boundary', () => {
  it('no core source value-imports @forge/contracts (type-only — prod image ships no contracts pkg)', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const hits = runtimeImportsOf(readFileSync(file, 'utf8'));
      if (hits.length) offenders.push(`${relative(SRC_ROOT, file)}\n    ${hits.join('\n    ')}`);
    }
    expect(
      offenders,
      `Value import(s) from @forge/contracts crash core at boot (ERR_MODULE_NOT_FOUND). ` +
        `Use \`import type\` or inline the value into core:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
