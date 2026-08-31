/**
 * ISS-889 §2 — "is this list complete?" must be answerable on every REST list.
 *
 * MCP carries the answer in the body, where it cannot go missing without the
 * parse failing. REST carries it in a header, which a handler can simply forget
 * to set — and the response still parses, still renders, and reports a
 * truncated page as a complete list. `apiClientList` now throws on the missing
 * header, so the failure is loud; this scan is what stops it being written in
 * the first place.
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

/**
 * A handler body, sliced from one `c.req` route registration to the next. Crude
 * on purpose: the question is only whether a pagination parse and a header
 * write live in the same handler, and a slice that is too wide can only make
 * the test more forgiving, never wrongly red.
 */
function handlerBodies(source: string): string[] {
  return executableLines(source)
    .split(/\.(?:get|post|put|patch|delete)\(/)
    .slice(1);
}

/**
 * The source with comments removed. A commented-out `setTotalCount` is exactly
 * the shape a regression takes, and a substring search would read it as present.
 */
// cm:guard strip comments BEFORE searching. Measured 2026-08-31: commenting out the only `setTotalCount` in `issues/routes.ts` left this gate green, because the call still appeared in the text — the scan proved nothing until this ran first.
function executableLines(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('every paginated REST list states its own total', () => {
  it('never parses pagination in a handler that returns rows without setTotalCount', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('paginationSchema')) continue;

      for (const body of handlerBodies(source)) {
        const paginates = /\blimit\b/.test(body) && /\boffset\b/.test(body);
        if (!paginates) continue;
        // cm:why a handler that never answers with rows is not a list route — DELETE and POST parse the same schema shape without returning a page to count
        if (!/c\.json\(/.test(body)) continue;
        if (body.includes('setTotalCount')) continue;
        if (body.includes('buildListEnvelope')) continue;
        offenders.push(`${relative(SRC, file)} — a paginated handler with no setTotalCount`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // cm:guard the header only reaches a browser while its name is in the CORS allow-list; drop it there and every list in web-v2 starts throwing, because `apiClientList` refuses to guess. That is the intended failure — loud beats a silently truncated page — but the pairing is invisible from either file, so it is asserted here.
  it('keeps X-Total-Count exposed through CORS', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(index).toMatch(/exposeHeaders:\s*\[[^\]]*'X-Total-Count'/);
  });
});
