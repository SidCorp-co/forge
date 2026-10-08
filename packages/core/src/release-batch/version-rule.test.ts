// The version rule (ADR 0011), on the shapes that made it: HOP's one roster cut three times on
// 2026-10-07, the same with a tag pushed on attempt 1, a roster that grew, and an attempt that never
// said what left its box.

import { describe, expect, it } from 'vitest';
import { releaseLinesOf } from './release-cuts.js';
import {
  carriersOf,
  decideVersion,
  type LineageRun,
  lineageOf,
  rosterKey,
  UNNAMED_PUSH,
} from './version-rule.js';

const ROSTER = ['c', 'a', 'b'];
let clock = Date.UTC(2026, 9, 7, 19, 0);

function run(over: Partial<LineageRun> & { version: string }): LineageRun {
  clock += 60_000;
  return {
    id: `run-${over.version}-${clock}`,
    startedAt: new Date(clock),
    status: 'cancelled',
    releasedAt: null,
    endedAt: null,
    roster: ROSTER,
    reachedBox: true,
    hasJob: true,
    metadata: {},
    ...over,
  };
}

const said = (carried: unknown[]) => ({ carried: { carriers: carried, by: 'u', at: 'now' } });
const NOTHING_LEFT = { abort: { pushed: false, reason: 'refused', roster: 'released' } };
const SILENT = { abort: { reason: 'refused', roster: 'released' } };
const shipped = (version: string) =>
  run({ version, status: 'completed', releasedAt: new Date(clock + 1) });

describe('a re-cut of the same roster', () => {
  it('wears the version its first cut claimed while nothing outside Forge carries it (HOP 0.3.0 → 0.5.0)', () => {
    const first = run({ version: '0.3.0', metadata: NOTHING_LEFT });
    const second = decideVersion([first], ['a', 'b', 'c'], null);
    expect(second).toMatchObject({ kind: 'reused', version: '0.3.0', attempt: 2 });

    const again = run({ version: '0.3.0', metadata: NOTHING_LEFT });
    const third = decideVersion([first, again], ['b', 'c', 'a'], null);
    expect(third).toMatchObject({ kind: 'reused', version: '0.3.0', attempt: 3 });
  });

  it('takes a new version when a tag pushed on attempt 1 carries it, and names the tag', () => {
    const first = run({ version: '0.3.0', metadata: said([{ kind: 'tag', name: 'v0.3.0' }]) });
    const second = decideVersion([first], ROSTER, null);
    expect(second).toMatchObject({
      kind: 'bumped',
      version: '0.4.0',
      attempt: 2,
      carriers: [{ kind: 'tag', name: 'v0.3.0' }],
    });
  });

  it('bumps on a push the abort reported without naming it, and says so', () => {
    const first = run({ version: '0.3.0', metadata: { abort: { pushed: true, reason: 'x' } } });
    expect(decideVersion([first], ROSTER, null)).toMatchObject({
      kind: 'bumped',
      carriers: [UNNAMED_PUSH],
    });
  });

  it('is undecided while an attempt that wore the version reached a box and never said', () => {
    const first = run({ version: '0.3.0', metadata: SILENT });
    expect(decideVersion([first], ROSTER, null)).toMatchObject({
      kind: 'undecided',
      version: '0.3.0',
      silent: { id: first.id },
    });
  });

  it('a later declaration of nothing decides it, and a declaration never takes a carrier back', () => {
    const declared = run({ version: '0.3.0', metadata: { ...SILENT, ...said([]) } });
    expect(decideVersion([declared], ROSTER, null)).toMatchObject({ kind: 'reused' });
    const tagged = run({
      version: '0.3.0',
      metadata: { ...SILENT, abort: { pushed: true }, ...said([]) },
    });
    expect(carriersOf(tagged)).toEqual({ kind: 'carried', carriers: [UNNAMED_PUSH] });
  });

  it('an attempt no box ever took did nothing outside Forge', () => {
    const unstarted = run({ version: '0.3.0', reachedBox: false });
    expect(decideVersion([unstarted], ROSTER, null)).toMatchObject({
      kind: 'reused',
      version: '0.3.0',
    });
  });

  it('never wears a version another release already wears, the hand-back a cut before the rule made', () => {
    const a = run({ version: '0.4.0', roster: ['a'], metadata: NOTHING_LEFT });
    const b = run({
      version: '0.4.0',
      roster: ['b'],
      status: 'completed',
      releasedAt: new Date(clock + 1),
    });
    expect(decideVersion([a, b], ['a'], null)).toMatchObject({
      kind: 'bumped',
      version: '0.5.0',
      carriers: [],
      line: null,
      takenBy: b.id,
    });
  });

  it('moves off a version the declared prerelease line no longer hands out', () => {
    const first = run({ version: '0.4.0-dev.7', metadata: NOTHING_LEFT });
    const line = { of: { major: 0, minor: 5, patch: 0 }, label: 'dev' };
    expect(decideVersion([first], ROSTER, line)).toMatchObject({
      kind: 'bumped',
      version: '0.5.0-dev.1',
      carriers: [],
      line: '0.5.0-dev',
    });
  });
});

describe('a roster that is not the same set is a new release', () => {
  it('takes a new version when an issue is added or dropped, and leaves the earlier one claimed', () => {
    const first = run({ version: '0.3.0', metadata: NOTHING_LEFT });
    expect(decideVersion([first], ['a', 'b'], null)).toEqual({ kind: 'first', version: '0.4.0' });
    expect(decideVersion([first], ['a', 'b', 'c', 'd'], null)).toEqual({
      kind: 'first',
      version: '0.4.0',
    });
  });

  it('names a set: order and repeats never make two rosters differ', () => {
    expect(rosterKey(['b', 'a', 'a'])).toBe(rosterKey(['a', 'b']));
  });

  it('starts after the highest version ever attempted, not the highest shipped', () => {
    const aborted = run({ version: '0.7.0', roster: ['x'], metadata: NOTHING_LEFT });
    expect(decideVersion([shipped('0.2.0'), aborted], ['y'], null)).toEqual({
      kind: 'first',
      version: '0.8.0',
    });
  });

  it('an ended run with no release job was refused at the door and claims nothing', () => {
    const refused = run({ version: '0.3.0', hasJob: false, reachedBox: false });
    expect(decideVersion([refused], ['z'], null)).toEqual({ kind: 'first', version: '0.1.0' });
  });
});

describe('the releases a project lists', () => {
  it("reads HOP's three cuts of one roster as one release with three attempts, under the shipped version", () => {
    const r3 = run({ version: '0.3.0', metadata: SILENT });
    const r4 = run({ version: '0.4.0', metadata: NOTHING_LEFT });
    const r5 = shipped('0.5.0');
    const lines = releaseLinesOf(lineageOf([r5, r3, r4]));
    expect([...lines.groups.keys()]).toEqual(['0.5.0']);
    expect(lines.groups.get('0.5.0')?.map((r) => r.version)).toEqual(['0.3.0', '0.4.0', '0.5.0']);
    expect(lines.keyOf.get(r3.id)).toBe('0.5.0');
  });

  it('keeps a roster that changed as its own release', () => {
    const a = run({ version: '0.1.0', roster: ['a'], metadata: NOTHING_LEFT });
    const b = shipped('0.2.0');
    const lines = releaseLinesOf(lineageOf([a, b]));
    expect([...lines.groups.keys()].sort()).toEqual(['0.1.0', '0.2.0']);
  });
});
