// ISS-979 (the owner's mockup v3): a lane is read by core, never inferred by the page. Status moves
// close in time are one batch (one entry per issue, from its first status to its last), the
// decisions waiting on the reader are pins where each wait began, a run ended before the lane is not
// drawn, and a release marker reads its run's state.
//
// @direct-test-of packages/core/src/activity/lane-releases.ts

import type { OrgActivityPerson } from '@forge/contracts/org-activity';
import { describe, expect, it } from 'vitest';
import type { ProjectEvent } from './events.js';
import { batchesOf, laneOf, lastActivityOf, runsOf, waitsOf } from './lane.js';
import { releaseStateOf } from './lane-releases.js';

const NOW = new Date('2026-11-05T09:11:00.000Z');
const FROM = new Date(NOW.getTime() - 120 * 60_000);
const at = (hm: string) => `2026-11-05T${hm}:00.000Z`;

const move = (
  hm: string,
  key: string,
  from: ProjectEvent['to'] | undefined,
  to: ProjectEvent['to'],
): ProjectEvent => ({
  at: at(hm),
  kind: 'status',
  issueKey: key,
  issueTitle: `Title of ${key}`,
  to,
  ...(from ? { from } : {}),
});

/** Events as the read answers them: newest first. */
const newestFirst = (events: ProjectEvent[]) =>
  [...events].sort((a, b) => b.at.localeCompare(a.at));

const person = (over: Partial<OrgActivityPerson>): OrgActivityPerson => ({
  decisionId: 'd',
  group: 'answer',
  key: null,
  title: 'A question',
  since: null,
  opens: null,
  ...over,
});

describe('a lane reads status moves as batches', () => {
  it('gathers moves within fifteen minutes of a batch first move, and starts a new batch after', () => {
    const batches = batchesOf(
      newestFirst([
        move('07:24', 'ISS-967', 'in_progress', 'awaiting_release'),
        move('07:30', 'ISS-968', 'open', 'in_progress'),
        move('07:39', 'ISS-969', 'open', 'in_progress'),
        // sixteen minutes after the first: a batch of its own
        move('07:40', 'ISS-970', 'open', 'in_progress'),
        move('08:58', 'ISS-972', 'in_progress', 'awaiting_release'),
      ]),
      FROM,
      NOW,
    );
    expect(batches.map((b) => [b.at, b.moves.map((m) => m.issueKey)])).toEqual([
      [at('07:24'), ['ISS-967', 'ISS-968', 'ISS-969']],
      [at('07:40'), ['ISS-970']],
      [at('08:58'), ['ISS-972']],
    ]);
  });

  it('an issue that moved twice in one batch is one entry, from its first status to its last', () => {
    const [batch] = batchesOf(
      newestFirst([
        move('08:00', 'ISS-1', 'open', 'in_progress'),
        move('08:05', 'ISS-1', 'in_progress', 'awaiting_release'),
        move('08:06', 'ISS-2', 'open', 'in_progress'),
      ]),
      FROM,
      NOW,
    );
    expect(batch?.moves).toEqual([
      { issueKey: 'ISS-1', title: 'Title of ISS-1', from: 'open', to: 'awaiting_release' },
      { issueKey: 'ISS-2', title: 'Title of ISS-2', from: 'open', to: 'in_progress' },
    ]);
  });

  it('a move before the lane, or one with no status it came from, is read as such', () => {
    const batches = batchesOf(
      newestFirst([
        move('07:00', 'ISS-1', 'open', 'in_progress'),
        move('08:00', 'ISS-2', undefined, 'open'),
      ]),
      FROM,
      NOW,
    );
    expect(batches).toEqual([
      {
        at: at('08:00'),
        moves: [{ issueKey: 'ISS-2', title: 'Title of ISS-2', from: null, to: 'open' }],
      },
    ]);
  });

  it('a move naming no issue is refused by name, never dropped', () => {
    const broken: ProjectEvent = {
      at: at('08:00'),
      kind: 'status',
      issueKey: null,
      issueTitle: null,
      to: 'open',
    };
    expect(() => batchesOf([broken], FROM, NOW)).toThrow(/names no issue/);
  });

  it('passes and other events draw no batch', () => {
    const events: ProjectEvent[] = [
      { at: at('08:00'), kind: 'pass_opened', issueKey: null, issueTitle: null },
      { at: at('08:01'), kind: 'pass_settled', issueKey: null, issueTitle: null, dispatched: 0 },
      { at: at('08:02'), kind: 'merged', issueKey: 'ISS-3', issueTitle: 'x' },
    ];
    expect(batchesOf(events, FROM, NOW)).toEqual([]);
    expect(Object.keys(laneOf(events, FROM, NOW, [], []))).toEqual([
      'from',
      'runs',
      'batches',
      'releases',
      'waits',
    ]);
  });
});

describe('a lane pins what waits on the reader where each wait began', () => {
  it('one pin per wait window; a wait begun before the lane, or with no start, stands at its edge', () => {
    const waits = waitsOf(
      [
        person({ decisionId: 'a', since: at('08:40') }),
        person({ decisionId: 'b', since: at('08:44') }),
        person({ decisionId: 'c', since: at('05:00') }),
        person({ decisionId: 'd', since: null }),
        person({ decisionId: 'e', since: at('09:00') }),
      ],
      FROM,
    );
    expect(waits.map((w) => [w.at, w.items.map((i) => i.decisionId)])).toEqual([
      [FROM.toISOString(), ['c', 'd']],
      [at('08:40'), ['a', 'b']],
      [at('09:00'), ['e']],
    ]);
  });

  it('nothing waiting draws no pin', () => {
    expect(waitsOf([], FROM)).toEqual([]);
  });
});

describe('a lane draws runs, and says when the project last moved', () => {
  it('a live run reaches now, an ended one stops, one ended before the lane is not drawn', () => {
    const runs = runsOf(
      newestFirst([
        { at: at('06:00'), kind: 'run_started', issueKey: null, issueTitle: null, span: 'old' },
        { at: at('06:30'), kind: 'run_ended', issueKey: null, issueTitle: null, span: 'old' },
        { at: at('07:00'), kind: 'run_started', issueKey: null, issueTitle: null, span: 'a' },
        { at: at('07:52'), kind: 'run_ended', issueKey: null, issueTitle: null, span: 'a' },
        { at: at('09:05'), kind: 'run_started', issueKey: null, issueTitle: null, span: 'b' },
      ]),
      FROM,
    );
    expect(runs).toEqual([
      { from: FROM.toISOString(), to: at('07:52') },
      { from: at('09:05'), to: null },
    ]);
  });

  it('the last activity is the newest event or the last pass, whichever is later', () => {
    expect(lastActivityOf([move('08:58', 'ISS-1', 'open', 'in_progress')], at('09:02'))).toBe(
      at('09:02'),
    );
    expect(lastActivityOf([move('08:58', 'ISS-1', 'open', 'in_progress')], null)).toBe(at('08:58'));
    expect(lastActivityOf([], null)).toBeNull();
  });
});

describe('a release marker reads its run', () => {
  it('shipped is released, an open run releasing, an aborted one stopped, any other end failed', () => {
    expect(releaseStateOf({ status: 'completed', released_at: at('08:00'), metadata: {} })).toBe(
      'released',
    );
    expect(releaseStateOf({ status: 'running', released_at: null, metadata: {} })).toBe(
      'releasing',
    );
    expect(releaseStateOf({ status: 'paused', released_at: null, metadata: {} })).toBe('releasing');
    expect(
      releaseStateOf({
        status: 'cancelled',
        released_at: null,
        metadata: { abort: { reason: 'x' } },
      }),
    ).toBe('stopped');
    expect(releaseStateOf({ status: 'failed', released_at: null, metadata: {} })).toBe('failed');
  });
});
