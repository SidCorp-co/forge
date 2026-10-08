// A second declaration of the status-to-work-state map is two screens disagreeing about one
// project with nothing red, so this walks core's source the way `status-sets-parity.test.ts` binds
// the one copy that is allowed: `issues/work-state.ts`, which that test holds equal to contracts'.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import { WORK_STATES } from './work-state.js';

const SRC = resolve(__dirname, '..');
const MIRROR = 'issues/work-state.ts';
// A total map has all seventeen statuses, and a partial one is still a second map. Twelve spares
// the short lists that name a handful of statuses for their own query.
const MAJORITY = 12;

const STATE_ALTERNATION = WORK_STATES.join('|');
const KEY_TO_STATE = new RegExp(
  `^\\s*['"]?(${issueStatuses.join('|')})['"]?\\s*:\\s*['"](${STATE_ALTERNATION})['"]`,
  'u',
);

/** How many distinct statuses `text` files under a work state, by an entry of the form `status: 'state'`. */
function statusesFiledUnderStates(text: string): number {
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const m = KEY_TO_STATE.exec(line);
    if (m?.[1]) seen.add(m[1]);
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
