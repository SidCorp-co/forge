// A second declaration of the status-to-work-state map is two screens disagreeing about one
// project with nothing red, so this walks core's source the way `status-sets-parity.test.ts` binds
// the one copy that is allowed: `issues/work-state.ts`, which that test holds equal to contracts'.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import { STATUS_WORK_STATE, WORK_STATES } from './work-state.js';

const SRC = resolve(__dirname, '..');
const MIRROR = 'issues/work-state.ts';
// A total map has all seventeen statuses, and a partial one is still a second map. Twelve spares
// the short lists that name a handful of statuses for their own query.
const MAJORITY = 12;

const STATE_ALTERNATION = WORK_STATES.join('|');
const STATUS_ALTERNATION = issueStatuses.join('|');
const QUOTED = (alternation: string, capture = true) =>
  `['"\`](${capture ? '' : '?:'}${alternation})['"\`]`;
const STATUS_LITERAL = new RegExp(QUOTED(STATUS_ALTERNATION), 'gu');
// Every layout a map takes reads the same way: a status and a state next to each other with only
// punctuation between them. `status: 'state'`, `['status', 'state']`, `case 'status': return 'state'`
// and `'status' => 'state'` are all that, one entry per line or twelve to a line.
const STATUS_THEN_STATE = new RegExp(
  `(?:${QUOTED(STATUS_ALTERNATION)}|\\b(${STATUS_ALTERNATION})\\b)\\s*(?::|,|=>)?\\s*(?:return\\s+)?${QUOTED(STATE_ALTERNATION, false)}`,
  'gu',
);
// The other way round: a state naming the statuses it holds, `state: ['status', ...]` or
// `state: new Set([...])`. Its list is read to the closing bracket, so a long one is not cut short.
const STATE_THEN_STATUSES = new RegExp(
  `(?:${QUOTED(STATE_ALTERNATION, false)}|\\b(?:${STATE_ALTERNATION})\\b)\\s*:\\s*(?:new\\s+Set\\s*\\(\\s*)?\\[([^\\]]*)\\]`,
  'gu',
);

// A layout none of the patterns above reads still has to name the statuses it files and the words of
// the states it files them under, so a file holding most of the first and the states no status shares
// a spelling with is a second map however it is arranged: grouped `case` labels, a list walked by a
// loop, a table built from two arrays.
const STATE_WORDS_NO_STATUS_SHARES = WORK_STATES.filter(
  (w) => !(issueStatuses as readonly string[]).includes(w),
);
const STATUS_NAMED = new RegExp(
  `${QUOTED(STATUS_ALTERNATION)}|\\b(${STATUS_ALTERNATION})\\s*:`,
  'gu',
);

function statusesNamed(text: string): Set<string> {
  const seen = new Set<string>();
  for (const m of text.matchAll(STATUS_NAMED)) {
    const status = m[1] ?? m[2];
    if (status) seen.add(status);
  }
  return seen;
}

function namesTheStateWords(text: string): boolean {
  const named = STATE_WORDS_NO_STATUS_SHARES.filter((w) =>
    new RegExp(`(?:['"\`]${w}['"\`]|\\b${w}\\b\\s*:)`, 'u').test(text),
  );
  return named.length >= 2;
}

/** How many distinct statuses `text` files under a work state, in whatever layout the map is written. */
function statusesFiledUnderStates(text: string): number {
  const seen = new Set<string>();
  for (const m of text.matchAll(STATUS_THEN_STATE)) {
    const status = m[1] ?? m[2];
    if (status) seen.add(status);
  }
  for (const m of text.matchAll(STATE_THEN_STATUSES)) {
    for (const s of (m[1] ?? '').matchAll(STATUS_LITERAL)) if (s[1]) seen.add(s[1]);
  }
  const named = statusesNamed(text);
  if (named.size >= MAJORITY && namesTheStateWords(text)) {
    for (const status of named) seen.add(status);
  }
  return seen.size;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...sourceFiles(full));
    } else if (extname(entry) === '.ts' && !/\.test\.ts$/u.test(entry)) out.push(full);
  }
  return out;
}

describe('the scanner', () => {
  const entries = (n: number, state: string) =>
    issueStatuses
      .slice(0, n)
      .map((s) => `  ${s}: '${state}',`)
      .join('\n');

  // The one map, written every way a second copy could be laid out. Each of these is a second
  // declaration of the same thing, so each one must reach the threshold the walk refuses.
  const pairs = issueStatuses.map((s) => [s, STATUS_WORK_STATE[s]] as const);
  const LAYOUTS: Record<string, string> = {
    'one entry per line': pairs.map(([s, w]) => `  ${s}: '${w}',`).join('\n'),
    'four entries to a line': Array.from({ length: Math.ceil(pairs.length / 4) }, (_, i) =>
      pairs
        .slice(i * 4, i * 4 + 4)
        .map(([s, w]) => `${s}: '${w}'`)
        .join(', '),
    ).join(',\n'),
    'every entry on one line': `{ ${pairs.map(([s, w]) => `${s}: '${w}'`).join(', ')} }`,
    'quoted keys, double quotes': pairs.map(([s, w]) => `  "${s}": "${w}",`).join('\n'),
    'a Map of tuples': `new Map([${pairs.map(([s, w]) => `['${s}', '${w}']`).join(', ')}])`,
    'a switch': pairs.map(([s, w]) => `case '${s}': return '${w}';`).join('\n'),
    'an entry split across lines': pairs.map(([s, w]) => `  '${s}':\n    '${w}',`).join('\n'),
    'grouped switch cases': WORK_STATES.map(
      (w) =>
        `${pairs
          .filter(([, x]) => x === w)
          .map(([s]) => `case '${s}':`)
          .join(' ')} return '${w}';`,
    ).join('\n'),
    'a table built from two arrays walked by a loop': `const FROM = [${pairs
      .map(([s]) => `'${s}'`)
      .join(', ')}];\nconst TO = [${pairs.map(([, w]) => `'${w}'`).join(', ')}];`,
    'a map written state first': WORK_STATES.map(
      (w) =>
        `  ${w}: [${pairs
          .filter(([, x]) => x === w)
          .map(([s]) => `'${s}'`)
          .join(', ')}],`,
    ).join('\n'),
    'a map written state first, as sets': WORK_STATES.map(
      (w) =>
        `  ${w}: new Set([${pairs
          .filter(([, x]) => x === w)
          .map(([s]) => `'${s}'`)
          .join(', ')}]),`,
    ).join('\n'),
  };

  it.each(Object.entries(LAYOUTS))(
    'counts every status of a second map written as %s',
    (_layout, text) => {
      expect(statusesFiledUnderStates(text)).toBe(issueStatuses.length);
    },
  );

  it('counts a map that files the statuses under states, single or double quoted', () => {
    expect(statusesFiledUnderStates(entries(17, 'in_flight'))).toBe(17);
    expect(statusesFiledUnderStates(entries(17, 'in_flight').replaceAll("'", '"'))).toBe(17);
  });

  it('goes red on a second total map: it reaches the threshold the walk refuses', () => {
    expect(statusesFiledUnderStates(entries(17, 'finished'))).toBeGreaterThanOrEqual(MAJORITY);
  });

  it('leaves a short list of statuses for one query alone', () => {
    expect(statusesFiledUnderStates(entries(4, 'open'))).toBeLessThan(MAJORITY);
  });

  it('leaves a list of statuses with no state beside them alone', () => {
    const list = `const ALL = [${issueStatuses.map((s) => `'${s}'`).join(', ')}];`;
    expect(statusesFiledUnderStates(list)).toBeLessThan(MAJORITY);
  });

  it('does not read a status-to-label map as a work-state map', () => {
    const labels = issueStatuses.map((s) => `  ${s}: 'Open',`).join('\n');
    expect(statusesFiledUnderStates(labels)).toBe(0);
  });
});

describe('the one core copy of the status-to-work-state map', () => {
  const FILES = sourceFiles(SRC).map((f) => ({
    path: relative(SRC, f),
    text: readFileSync(f, 'utf8'),
  }));

  it('walks a tree that is actually there', () => {
    expect(FILES.length).toBeGreaterThan(200);
  });

  it('finds the one that is allowed, so the walk is not passing on a broken pattern', () => {
    const mirror = FILES.find((f) => f.path === MIRROR);
    expect(statusesFiledUnderStates(mirror?.text ?? '')).toBe(issueStatuses.length);
  });

  it('declares no second one anywhere else in core', () => {
    const found = FILES.filter((f) => f.path !== MIRROR)
      .map((f) => ({ path: f.path, n: statusesFiledUnderStates(f.text) }))
      .filter((f) => f.n >= MAJORITY)
      .map((f) => `${f.path}: ${f.n} statuses filed under a work state`);
    expect(found).toEqual([]);
  });
});
