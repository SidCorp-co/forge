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
 * `docs/modules/control-observability/README.md`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Drizzle model var names for the three tables `0219`'s triggers watch. */
const KERNEL_TABLES = ['jobs', 'agentSessions', 'pipelineRuns'];

// cm:why a `projects` or `issues` DELETE removes kernel rows without naming a kernel table: `jobs.project_id`, `agent_sessions.project_id` and `pipeline_runs.project_id` are all `ON DELETE CASCADE`, and so is `pipeline_runs.issue_id`. The cascade runs in the parent's transaction, so the parent's marker covers every child — which is exactly why the parent has to carry one.
const CASCADING_PARENTS = ['projects', 'issues'];

const DELETE_TABLES = [...KERNEL_TABLES, ...CASCADING_PARENTS];

// cm:guard `transition.ts` is exempt because it stamps through `stampKernelTxn` itself, inside the transaction it opens; `db/kernel-marker.ts` is the stamp. Adding a third name here is how the whole guard stops meaning anything, so a new entry needs the reason it cannot use `withKernelMarker` written next to it.
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
// cm:why the walk is a heuristic and its failure direction is the reason that is acceptable: `stripComments` runs first and could eat a `//` inside a string, so a pathological file could close a marked range early — which reports a WRAPPED write as unwrapped. That is a loud false positive on the next run, never a silent pass, so the guard cannot be defeated by the imprecision it admits.
function markedRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const stack: Array<{ at: number; marked: boolean }> = [];
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
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
  // cm:guard an unbalanced walk means this file is not parseable HERE, so the answer is `opaque` — the conservative one. Returning "no status" would clear whatever the walk failed to read, which is the one direction a guard may not fail in.
  return { opaque: true, topLevel: '' };
}

/**
 * The write shapes that owe a marker.
 *
 * A `.set()` whose argument is an object literal is cleared when its top level
 * carries neither a `status` key nor a spread of a bare identifier — the latter
 * because `{ ...patch }` is exactly as unprovable as `.set(patch)`. Any other
 * argument is a violation: nothing static can show it carries no status, and
 * the shapes that actually reach here (a `patch`-built `updates` object,
 * `buildRequeueUpdate`) all write one.
 */
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

  // cm:why raw SQL is the other door into the same rows and the same triggers, and `transition-guard.test.ts` already scans for it on the terminal axis — a `sql.raw` sweeper or a `db.execute(sql\`…\`)` owes the marker for exactly the reason a drizzle chain does.
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

  // cm:guard the meta-test is the whole evidence for the one above: a scanner with a broken paren walk or a typo'd table name reports zero violations on a clean tree and zero on a dirty one, and the two greens are indistinguishable. Every shape this guard claims to catch is planted here.
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

  // cm:guard a `cm:` note is allowed to quote the very shapes above — they are the clearest way to say what the rule is — so the comment stripper has to run before the scan or the doctrine that documents this guard breaks it.
  it('ignores the shapes when they appear in a comment', () => {
    const commented = [
      "// await db.update(jobs).set({ status: 'queued' });",
      '/* await db.delete(projects); */',
    ].join('\n');
    expect(findViolations('synthetic.ts', commented)).toEqual([]);
  });
});
