// ISS-1415: the rules every re-placement of one item reads after its box lost the last jobs' panes.
//
// @direct-test-of packages/core/src/jobs/pane-loss.ts

import { describe, expect, it } from 'vitest';
import {
  endedOnPaneLoss,
  PANE_LOSS_CAP,
  paneLossPlacement,
  paneLossStopSentence,
  paneLossStreak,
} from './pane-loss.js';

const LOST = "the job's pane `forge-job-f442147f` ended without reporting an outcome";
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);
const lost = (minAgo = 0, askedByPerson = false) => ({
  status: 'failed',
  error: LOST,
  endedAt: at(minAgo),
  askedByPerson,
});

describe("what counts as the box losing a job's pane", () => {
  it('reads both of the runner’s sentences, and nothing else', () => {
    expect(endedOnPaneLoss(LOST)).toBe(true);
    expect(
      endedOnPaneLoss(
        "the job's pane `forge-job-x` did not survive a restart of the runner daemon",
      ),
    ).toBe(true);
    expect(endedOnPaneLoss('[pool] job 5b0e386f lost its pane forge-job-5b0e386f')).toBe(true);
    expect(endedOnPaneLoss('stream error: 529 overloaded')).toBe(false);
    expect(endedOnPaneLoss('the agent ended without reporting an outcome')).toBe(false);
    expect(endedOnPaneLoss(null)).toBe(false);
  });
});

describe('the streak of one item', () => {
  it('counts the newest losses in a row and stops at a success, another failure or a cancel', () => {
    expect(paneLossStreak([lost(), lost(3), lost(9)]).losses).toBe(3);
    expect(
      paneLossStreak([
        lost(),
        { status: 'done', error: null, endedAt: at(5), askedByPerson: false },
        lost(9),
      ]).losses,
    ).toBe(1);
    expect(
      paneLossStreak([
        lost(),
        { status: 'failed', error: '529', endedAt: at(5), askedByPerson: false },
        lost(9),
      ]).losses,
    ).toBe(1);
    expect(
      paneLossStreak([
        { status: 'cancelled', error: null, endedAt: at(1), askedByPerson: false },
        lost(9),
      ]).losses,
    ).toBe(0);
  });

  it('ends at the job a person resumed: their ask starts the count again', () => {
    const streak = paneLossStreak([lost(0), lost(2, true), lost(5), lost(8), lost(12)]);
    expect(streak.losses).toBe(2);
    expect(streak.lastFailure).toBe(LOST);
  });
});

describe('when the next job of the item may be placed', () => {
  const now = new Date();

  it('places at once with no loss, after 2, 4 and 8 minutes after 1, 2, 3, and never at the cap', () => {
    expect(paneLossPlacement(0, null, now)).toEqual({ kind: 'place' });
    for (const [n, minutes] of [
      [1, 2],
      [2, 4],
      [3, 8],
    ] as const) {
      const p = paneLossPlacement(n, now, now);
      expect(p.kind).toBe('wait');
      if (p.kind === 'wait') expect(p.at.getTime() - now.getTime()).toBe(minutes * 60_000);
    }
    expect(paneLossPlacement(PANE_LOSS_CAP, now, now)).toEqual({ kind: 'stop', losses: 4 });
    expect(paneLossPlacement(PANE_LOSS_CAP + 3, at(600), now).kind).toBe('stop');
  });

  it('places once the wait has passed', () => {
    expect(paneLossPlacement(2, at(5), now)).toEqual({ kind: 'place' });
    expect(paneLossPlacement(2, at(3), now).kind).toBe('wait');
  });

  it('names the item, the failure and the count when it stops', () => {
    const said = paneLossStopSentence({
      what: 'The steward’s release_followthrough',
      item: 'ISS-109',
      losses: 4,
      failure: LOST,
    });
    expect(said).toContain('ISS-109');
    expect(said).toContain('4 times in a row');
    expect(said).toContain(LOST);
    expect(said).toContain('a person asks for it again');
  });
});
