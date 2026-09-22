/**
 * ISS-1107 — one writer of `issues.status`, checked rather than asserted. A second writer lands in
 * `unaudited_transitions` and is charged to the interventions metric; the trigger is that backstop
 * and this is the front door, seeing a `.set()` naming `status` or raw SQL updating the column,
 * never a `.set(updates)` built elsewhere — the shape of `update-service.ts` and `extras-routes.ts`,
 * neither of which writes `status`. A RATCHET, not this issue's evidence: the property held on
 * `main` before it, so what goes red on a revert is `lifecycle/kernel-entity.test.ts` and
 * `unaudited-issue-transition.test.ts`, not this.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The one module that may move `issues.status`. */
const OWNER = 'issues/apply-transition.ts';

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so a note quoting `.update(issues)` cannot trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

interface StatusWrite {
  file: string;
  line: number;
  how: string;
}

/** The scan itself, measured by the planted cases rather than by a copy of it. */
function statusWritesIn(rel: string, source: string): StatusWrite[] {
  const text = stripComments(source);
  const found: StatusWrite[] = [];

  for (const hit of text.matchAll(/\.update\(\s*issues\s*\)\s*\.set\(/g)) {
    const from = hit.index + hit[0].length;
    const window = text.slice(from, from + 900);
    const stop = window.search(/\.(where|returning|onConflict|from)\s*\(/);
    const values = stop === -1 ? window : window.slice(0, stop);
    if (/(^|[\s{,])status\s*:/.test(values)) {
      found.push({ file: rel, line: lineOf(text, hit.index), how: '.update(issues) sets status' });
    }
  }

  // `(?!\bwhere\b)` is load-bearing: `release-batch/service.ts` sets
  // `release_batch_run_id` and filters `AND status = ...`, which a scan reaching
  // past WHERE would report as a write.
  for (const hit of text.matchAll(
    /update\s+(?:only\s+)?"?issues"?\s+set\b(?:(?!\bwhere\b)[\s\S]){0,400}?\bstatus\b\s*=/gi,
  )) {
    found.push({ file: rel, line: lineOf(text, hit.index), how: 'raw SQL updates issues.status' });
  }

  return found;
}

describe('one writer of issues.status (ISS-1107)', () => {
  it('finds a status write nowhere but the chokepoint', () => {
    const offenders: StatusWrite[] = [];
    for (const abs of listSourceFiles(SRC_ROOT)) {
      const rel = abs.slice(SRC_ROOT.length).replace(/^\//, '');
      if (rel === OWNER) continue;
      offenders.push(...statusWritesIn(rel, readFileSync(abs, 'utf8')));
    }

    expect(
      offenders,
      `\`issues.status\` has one writer, \`${OWNER}\`, which stamps \`forge.kernel_txn\` and writes the audit row in the same transaction. A write outside it lands in \`unaudited_transitions\` and is counted as manual SQL against the interventions metric. Route it through \`transitionIssueStatus\`.\n${offenders
        .map((o) => `  ${o.file}:${o.line} — ${o.how}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('still finds the write in the chokepoint, so the scan is not looking for nothing', () => {
    const owner = readFileSync(`${SRC_ROOT}${OWNER}`, 'utf8');
    expect(statusWritesIn(OWNER, owner).length).toBeGreaterThan(0);
  });

  it.each([
    [
      'a drizzle set',
      "await db.update(issues).set({ status: 'closed' }).where(eq(issues.id, id));",
    ],
    ['a multi-column set', 'await tx.update(issues).set({ updatedAt: now, status: s }).where(w);'],
    [
      'raw SQL',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted source line, not a string this test interpolates — the scan is what reads it
      "await db.execute(sql`update issues set status = 'closed' where id = ${id}`);",
    ],
  ])('catches %s', (_name, planted) => {
    expect(statusWritesIn('planted.ts', planted)).toHaveLength(1);
  });

  it.each([
    ['a non-status set', 'await db.update(issues).set({ title }).where(eq(issues.id, id));'],
    ['a status write on another table', "await db.update(jobs).set({ status: 'done' }).where(w);"],
    ['a comment quoting one', "// await db.update(issues).set({ status: 'closed' })"],
    [
      'status read in a WHERE beside another column being set',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted source line, not a string this test interpolates — the scan is what reads it
      'await db.execute(sql`UPDATE issues SET release_batch_run_id = ${r} WHERE status = ${g}`);',
    ],
  ])('does not catch %s', (_name, planted) => {
    expect(statusWritesIn('planted.ts', planted)).toEqual([]);
  });
});
