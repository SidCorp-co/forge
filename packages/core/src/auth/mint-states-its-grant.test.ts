/**
 * ISS-1255 — every mint in this package states what the token may reach.
 *
 * `mintPat` writes `null` for an omitted grant and `null` reaches the whole
 * menu, so a call leaving the field out mints the most powerful token the
 * menu can express. The subject is the call's own argument and not a variable
 * spread into it, which the next reader of that call site cannot see, and
 * non-test files only: a test may exercise the legacy shape.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(import.meta.dirname, '..');

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const NOT_SOURCE = ['.test.ts', '.test.tsx', '.fixture.ts', '.d.ts'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.turbo']);

const DECLARATION = 'auth/pat.ts';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(path);
    if (!entry.isFile()) return [];
    if (NOT_SOURCE.some((suffix) => path.endsWith(suffix))) return [];
    return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)) ? [path] : [];
  });
}

function fromSrc(path: string): string {
  return relative(SRC_ROOT, path).split(sep).join('/');
}

function argumentsOf(text: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return text.slice(openIndex + 1);
}

type CallSite = { file: string; args: string };

function callSites(): CallSite[] {
  const out: CallSite[] = [];
  for (const path of walk(SRC_ROOT)) {
    const file = fromSrc(path);
    const text = readFileSync(path, 'utf8');
    for (let at = text.indexOf('mintPat('); at !== -1; at = text.indexOf('mintPat(', at + 1)) {
      const before = text.slice(Math.max(0, at - 9), at);
      if (before.endsWith('function ')) continue;
      out.push({ file, args: argumentsOf(text, at + 'mintPat'.length) });
    }
  }
  return out;
}

describe('every mint in this package states its grant (ISS-1255)', () => {
  const sites = callSites();

  it('finds the call sites at all, so a scan that matched nothing cannot read as a pass', () => {
    expect(sites.filter((s) => s.file !== DECLARATION).length).toBeGreaterThanOrEqual(4);
  });

  it('names `permissions` in the argument of every call', () => {
    const silent = sites
      .filter((s) => s.file !== DECLARATION)
      .filter((s) => !/\bpermissions\s*:/.test(s.args))
      .map((s) => s.file);
    expect(silent, `${silent.join(', ')} mint(s) a token without saying what it may reach`).toEqual(
      [],
    );
  });
});
