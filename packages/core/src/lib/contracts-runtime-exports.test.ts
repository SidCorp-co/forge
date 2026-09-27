import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('..', import.meta.url).pathname;
const CONTRACTS_PKG = new URL('../../../contracts/package.json', import.meta.url).pathname;

type ExportEntry = { types?: string; default?: string } | string;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

// cm:guard — `pnpm deploy --prod` copies @forge/contracts under node_modules, where Node refuses
// to strip types, so a subpath core loads at runtime must resolve to compiled JS or core cannot
// start in the production image (ISS-1146). `import type` / `export type` are erased and exempt.
const SPECIFIER =
  /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"](@forge\/contracts(?:\/[^'"]*)?)['"]|import\(\s*['"](@forge\/contracts(?:\/[^'"]*)?)['"]\s*\)/g;

function runtimeContractSubpaths(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[3] ?? m[4];
    if (!spec || m[2]) continue;
    found.add(`.${spec.slice('@forge/contracts'.length)}`);
  }
  return [...found];
}

function exportOffence(subpath: string, entry: ExportEntry | undefined): string | null {
  if (entry === undefined) return `${subpath}: not declared in @forge/contracts exports`;
  const target = typeof entry === 'string' ? entry : entry.default;
  if (!target?.startsWith('./dist/') || !target.endsWith('.js')) {
    return `${subpath}: default is ${target ?? '(none)'}, must be ./dist/*.js`;
  }
  return null;
}

describe('@forge/contracts subpaths core loads at runtime ship compiled JS', () => {
  it('finds value imports and skips type-only ones', () => {
    expect(
      runtimeContractSubpaths(
        "import type { A } from '@forge/contracts/x';\nimport {\n  b,\n} from '@forge/contracts/y';\nexport { c } from '@forge/contracts';\nconst d = await import('@forge/contracts/z');",
      ).sort(),
    ).toEqual(['.', './y', './z']);
  });

  it('refuses a src default by name', () => {
    expect(exportOffence('./attachments', { default: './src/attachments.ts' })).toBe(
      './attachments: default is ./src/attachments.ts, must be ./dist/*.js',
    );
    expect(exportOffence('./gone', undefined)).toMatch(/not declared/);
  });

  it('every runtime-imported subpath points its default under ./dist/', () => {
    const exportsMap = JSON.parse(readFileSync(CONTRACTS_PKG, 'utf8')).exports as Record<
      string,
      ExportEntry
    >;
    const offences: string[] = [];
    for (const file of walk(SRC)) {
      for (const subpath of runtimeContractSubpaths(readFileSync(file, 'utf8'))) {
        const offence = exportOffence(subpath, exportsMap[subpath]);
        if (offence) offences.push(`${relative(SRC, file)} → ${offence}`);
      }
    }
    expect(offences).toEqual([]);
  });
});
