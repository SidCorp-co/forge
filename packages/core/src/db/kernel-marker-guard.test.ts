/**
 * ISS-943 — the guard that keeps the widened detector sound.
 *
 * `0219` counts ANY status change and ANY row deletion on `jobs`,
 * `agent_sessions` and `pipeline_runs` that arrives without `forge.kernel_txn`.
 * That is a measure of hands-on-the-database only while every legitimate writer
 * stamps the marker; one that does not charges its whole ordinary traffic to the
 * north-star metric as manual SQL, and nothing else would notice.
 *
 * Why this is a SECOND guard rather than a widening of the first, and why an
 * opaque `.set()` argument counts as a violation:
 * the kernel-transition chokepoint in `lifecycle/transition.ts`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Drizzle model var names for the three tables `0219`'s triggers watch. */
const KERNEL_TABLES = ['jobs', 'agentSessions', 'pipelineRuns'];

const CASCADING_PARENTS = ['projects', 'issues'];

const DELETE_TABLES = [...KERNEL_TABLES, ...CASCADING_PARENTS];

const EXEMPT = ['lifecycle/transition.ts', 'db/kernel-marker.ts'];

const MARKER = 'withKernelMarker';

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

/** Strip block + line comments so a `cm:` note quoting `.update(jobs)` can't trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every offset inside a `withKernelMarker(...)` argument list.
 *
 * A paren-depth walk rather than a regex, because the question is structural:
 * "is this write lexically inside a marked scope". String and template bodies
 * are skipped so a `(` in a message or an SQL fragment cannot unbalance it.
 */
function markedRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const stack: Array<{ at: number; marked: boolean }> = [];
  // A template literal holds `${ … }` whose contents are code, and that code may
  // open another template literal. Tracked in one `quote` variable, the inner
  // backtick reads as the outer one closing: every paren after it is scored in
  // the wrong state, and a genuine unmarked write can land outside every range
  // and go unreported. So quotes and interpolations share ONE stack.
  const lexical: Array<{ quote: string } | { interp: true; depth: number }> = [];
  const top = () => lexical[lexical.length - 1];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const cur = top();
    if (cur && 'quote' in cur) {
      if (ch === '\\') i++;
      else if (cur.quote === '`' && ch === '$' && body[i + 1] === '{') {
        lexical.push({ interp: true, depth: 0 });
        i++;
      } else if (ch === cur.quote) lexical.pop();
      continue;
    }
    if (cur && ch === '{') cur.depth++;
    else if (cur && ch === '}') {
      if (cur.depth === 0) lexical.pop();
      else cur.depth--;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      lexical.push({ quote: ch });
    } else if (ch === '(') {
      stack.push({ at: i, marked: body.slice(Math.max(0, i - MARKER.length), i) === MARKER });
    } else if (ch === ')') {
      const open = stack.pop();
      if (open?.marked) ranges.push([open.at, i]);
    }
  }
  return ranges;
}

function isInside(ranges: Array<[number, number]>, at: number): boolean {
  return ranges.some(([from, to]) => at > from && at < to);
}

/**
 * The `.set()` argument of the first `.set(` in `after`: whether it is an
 * opaque expression, and — when it is an object literal — its TOP-LEVEL text.
 *
 * Depth matters and a window grep gets it wrong in both directions. `metadata:
 * { ...current }` and `pipelineHealth: { ...baseHealth }` spread into a jsonb
 * COLUMN, not into the SET list, and a naive scan reads them as opaque; a
 * nested `status:` key inside a jsonb payload reads as a status write. Only the
 * top level of the SET object decides either question.
 */
function setArgument(after: string): { opaque: boolean; topLevel: string } | null {
  const at = after.search(/\.set\(/);
  if (at === -1) return null;
  let i = at + 5;
  while (i < after.length && /\s/.test(after[i] ?? '')) i++;
  if (after[i] !== '{') return { opaque: true, topLevel: '' };
  const top: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let j = i; j < after.length; j++) {
    const ch = after[j] as string;
    if (quote) {
      if (ch === '\\') j++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) return { opaque: false, topLevel: top.join('') };
      if (depth < 0) break;
    }
    if (depth === 1) top.push(ch);
  }
  return { opaque: true, topLevel: '' };
}

function findViolations(path: string, rawBody: string): string[] {
  const body = stripComments(rawBody);
  const ranges = markedRanges(body);
  const hits: string[] = [];

  for (const table of KERNEL_TABLES) {
    const re = new RegExp(`\\.update\\(\\s*${table}\\s*\\)`, 'g');
    for (let m = re.exec(body); m !== null; m = re.exec(body)) {
      const set = setArgument(body.slice(m.index));
      if (set === null) continue;
      const writesStatus =
        set.opaque || /\bstatus\s*:/.test(set.topLevel) || /\.\.\.\s*[A-Za-z_$]/.test(set.topLevel);
      if (!writesStatus || isInside(ranges, m.index)) continue;
      hits.push(
        `${path}: .update(${table}).set(${set.opaque ? 'opaque' : '{ status: … }'}) outside ${MARKER}`,
      );
    }
  }

  for (const table of DELETE_TABLES) {
    const re = new RegExp(`\\.delete\\(\\s*${table}\\s*\\)`, 'g');
    for (let m = re.exec(body); m !== null; m = re.exec(body)) {
      if (isInside(ranges, m.index)) continue;
      hits.push(`${path}: .delete(${table}) outside ${MARKER}`);
    }
  }

  const rawStatus = new RegExp(
    `UPDATE\\s+"?(${['jobs', 'agent_sessions', 'pipeline_runs'].join('|')})"?\\b[\\s\\S]{0,400}?status\\s*=`,
    'gi',
  );
  for (let m = rawStatus.exec(body); m !== null; m = rawStatus.exec(body)) {
    if (isInside(ranges, m.index)) continue;
    hits.push(`${path}: raw UPDATE ${m[1]} SET status outside ${MARKER}`);
  }
  const rawDelete = new RegExp(
    `DELETE\\s+FROM\\s+"?(${['jobs', 'agent_sessions', 'pipeline_runs', 'projects', 'issues'].join('|')})"?\\b`,
    'gi',
  );
  for (let m = rawDelete.exec(body); m !== null; m = rawDelete.exec(body)) {
    if (isInside(ranges, m.index)) continue;
    hits.push(`${path}: raw DELETE FROM ${m[1]} outside ${MARKER}`);
  }

  return hits;
}

describe('kernel marker guard (ISS-943)', () => {
  it('no status write and no kernel-row delete happens outside withKernelMarker', () => {
    const files = listSourceFiles(SRC_ROOT).filter(
      (f) => !EXEMPT.some((exempt) => f.endsWith(exempt)),
    );
    const violations = files.flatMap((file) => findViolations(file, readFileSync(file, 'utf8')));
    expect(
      violations,
      [
        'A status write or a kernel-row delete outside `withKernelMarker` stamps no',
        '`forge.kernel_txn`, so migration 0219’s triggers record it in',
        '`unaudited_transitions` and the interventions metric counts this code path as a',
        'human hand on the database. Route it through `db/kernel-marker.ts`.',
        'Offending sites:',
        violations.join('\n'),
      ].join('\n'),
    ).toEqual([]);
  });

  it('detects each planted bypass, and clears each planted stamp', () => {
    const plants: Array<[string, string]> = [
      ['opaque set', 'await db.update(agentSessions).set(updates).where(eq(x, y));'],
      ['literal status', "await db.update(jobs).set({ status: 'queued' }).where(eq(x, y));"],
      ['run status', "await db.update(pipelineRuns).set({ status: 'paused' }).where(eq(x, y));"],
      ['kernel delete', 'await db.delete(agentSessions).where(eq(x, y));'],
      ['cascading parent delete', 'await db.delete(projects).where(eq(x, y));'],
      ['literal spreading a variable', 'await db.update(jobs).set({ ...patch }).where(eq(x, y));'],
      ['raw status', 'sql.raw("UPDATE jobs SET status = \'queued\' WHERE id = 1")'],
      ['raw delete', 'db.execute(sql`DELETE FROM pipeline_runs WHERE id = 1`)'],
    ];
    for (const [name, planted] of plants) {
      expect(
        findViolations('synthetic.ts', planted),
        `planted ${name} went unreported`,
      ).not.toEqual([]);
      const stamped = `await withKernelMarker(db, async (tx) => { ${planted.replace(/\bdb\./g, 'tx.')} });`;
      expect(findViolations('synthetic.ts', stamped), `stamped ${name} reported anyway`).toEqual(
        [],
      );
    }
  });

  it('clears a write that provably carries no status, and a delete of a table nothing cascades from', () => {
    const clean = [
      'await db.update(jobs).set({ ackedAt: new Date(), killOutcome: null }).where(eq(x, y));',
      'await db.update(agentSessions).set({ lastHeartbeatAt: now }).where(eq(x, y));',
      'await db.delete(jobEvents).where(eq(x, y));',
      'db.execute(sql`UPDATE jobs SET held_by = NULL WHERE id = 1`)',
      'await db.update(jobs).set({ ...(flag ? { ackedAt: now } : {}) }).where(eq(x, y));',
    ].join('\n');
    expect(findViolations('synthetic.ts', clean)).toEqual([]);
  });

  it('ignores the shapes when they appear in a comment', () => {
    const commented = [
      "// await db.update(jobs).set({ status: 'queued' });",
      '/* await db.delete(projects); */',
    ].join('\n');
    expect(findViolations('synthetic.ts', commented)).toEqual([]);
  });
});

describe('markedRanges — a nested template literal may not unbalance the walk', () => {
  // Reproduced against `issues/routes.ts` on 2026-09-21; `markedRanges` states why.
  const body = [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${` IS the input under test — the walk has to read it as source text.
    'const m = `remove ${d.map((k) => `\\`${k}\\`` ).join(", ")} now`;',
    'await withKernelMarker(db, async (tx) => tx.delete(issues).where(eq(issues.id, id)));',
  ].join('\n');

  it('keeps a marked write inside its marker', () => {
    const at = body.indexOf('.delete(issues)');
    expect(at).toBeGreaterThan(-1);
    expect(isInside(markedRanges(body), at)).toBe(true);
  });

  it('leaves a genuinely unmarked write outside every range', () => {
    const loose = `${body}\nawait db.delete(issues).where(eq(issues.id, id));`;
    expect(isInside(markedRanges(loose), loose.lastIndexOf('.delete(issues)'))).toBe(false);
  });
});
