/**
 * ISS-889 §2 — the REST list contract, enforced where the compiler cannot see.
 *
 * `setTotalCount` is module-private, so no route can hand-roll the header: that
 * half is the type checker's. What it cannot see is WHICH helper a handler
 * chose. `wholeList` on a paginated route states `offset: 0` and a `hasMore`
 * computed against a page rather than the query — the envelope's own shape,
 * telling the caller a truncated page is the whole list. That is the failure
 * ISS-889 was filed about, and this scan is what keeps it out.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

// cm:guard strip comments BEFORE searching. Measured 2026-08-31: commenting out the only `setTotalCount` in `issues/routes.ts` left an earlier version of this gate green, because the call still appeared in the text — the scan proved nothing until this ran first.
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** One route registration body, from `.get(` / `.post(` to the next. */
function handlerBodies(source: string): string[] {
  return executable(source)
    .split(/\.(?:get|post|put|patch|delete)\(/)
    .slice(1);
}

function pages(body: string): boolean {
  return /\.limit\(/.test(body) && /\.offset\(/.test(body);
}

describe('the REST list contract', () => {
  it('answers a pageable list with listResponse, never wholeList', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      if (file.endsWith('lib/pagination.ts')) continue;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('wholeList(')) continue;

      for (const body of handlerBodies(source)) {
        if (!body.includes('wholeList(')) continue;
        if (!pages(body)) continue;
        offenders.push(`${relative(SRC, file)} — wholeList in a handler that pages`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('answers every paginated handler through the envelope', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      if (file.endsWith('lib/pagination.ts')) continue;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('.offset(')) continue;

      for (const body of handlerBodies(source)) {
        if (!pages(body)) continue;
        if (!/c\.json\(/.test(body)) continue;
        if (body.includes('listResponse(')) continue;
        offenders.push(`${relative(SRC, file)} — a paginated handler with no listResponse`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // cm:guard the header only reaches a browser while its name is in the CORS allow-list. The body now carries the same number, so losing it DEGRADES rather than breaks — but a caller still on the header form would silently read every list as short, so the pairing is asserted here rather than left to whoever edits the CORS block.
  it('keeps X-Total-Count exposed through CORS', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(index).toMatch(/exposeHeaders:\s*\[[^\]]*'X-Total-Count'/);
  });
});
